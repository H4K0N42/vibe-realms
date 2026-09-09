import { useLayoutEffect, type RefObject } from 'react';

/**
 * Makes a row of cards move to a new arrangement instead of jumping into it.
 *
 * The row is a grid, so React rearranging it moves every card between cells in
 * a single paint, and no CSS transition can catch that: transitions interpolate
 * properties, and nothing about any card's own style changed. So each card's
 * old position is measured before the change and compared with the new one
 * after it, and the difference is animated away. The card is therefore already
 * where it belongs from the first frame; it is only drawn as still on its way.
 *
 * A Web Animation rather than a transition, because it starts reliably without
 * a forced reflow and never fights the class-driven styles on the same element.
 */
const DURATION = 260;
// Most of the distance is covered early: the arrangement reads as settled well
// before it stops moving, which is what makes it feel quick rather than slow.
const EASING = 'cubic-bezier(.22, 1, .36, 1)';

/** Where every card was last time, per row. Keyed by the element, so a remount starts fresh. */
const seen = new WeakMap<HTMLElement, Map<string, DOMRect>>();
/** One flight per card at a time; a second would fight the first over the transform. */
const running = new WeakMap<Element, Animation>();

interface Point { x: number; y: number; }

/** How far a card is drawn from where it belongs, or nothing if it is not in flight. */
function carriedBy(item: HTMLElement): Point {
  const flight = running.get(item);
  if (!flight || flight.playState !== 'running') return { x: 0, y: 0 };
  const transform = getComputedStyle(item).transform;
  if (!transform || transform === 'none') return { x: 0, y: 0 };
  const m = new DOMMatrixReadOnly(transform);
  return { x: m.m41, y: m.m42 };
}

/**
 * The box a card occupies in the layout, with whatever flight it is on taken
 * back out of the answer.
 *
 * Anything hit testing this row has to ask in these terms. A plain
 * `getBoundingClientRect()` reports where the card is being *drawn*, which for
 * a quarter of a second after every rearrangement is somewhere between two
 * cells. Deciding the new arrangement from that feeds the row's own animation
 * back into its answer: wiggle a card across a boundary and the same pointer
 * position lands in different places depending on how far the neighbours
 * happened to have slid, which reads as the row giving up on following you.
 */
export function layoutBox(item: HTMLElement): DOMRect {
  const r = item.getBoundingClientRect();
  const off = carriedBy(item);
  if (off.x === 0 && off.y === 0) return r;
  return new DOMRect(r.left - off.x, r.top - off.y, r.width, r.height);
}

export function useFlipRow(row: RefObject<HTMLElement | null>, order: string) {
  useLayoutEffect(() => {
    const el = row.current;
    if (!el) return;

    const items = [...el.querySelectorAll<HTMLElement>('[data-flip-id]')];
    const carried = new Map<string, Point>();
    const now = new Map<string, DOMRect>();
    for (const item of items) {
      carried.set(item.dataset.flipId!, carriedBy(item));
      now.set(item.dataset.flipId!, layoutBox(item));
    }

    const before = seen.get(el);
    seen.set(el, now);
    if (!before || matchMedia('(prefers-reduced-motion: reduce)').matches) return;

    for (const item of items) {
      const id = item.dataset.flipId!;
      const was = before.get(id);
      if (!was) continue; // Newly dealt: it has no old place to come from.
      const is = now.get(id)!;
      const off = carried.get(id)!;
      // Start from where the card was last actually drawn, which is its old
      // place plus however far an interrupted flight had carried it. Measuring
      // the drawn position instead and calling it the layout would compound the
      // error on every crossing until the row is millions of pixels off screen.
      const dx = was.left + off.x - is.left;
      const dy = was.top + off.y - is.top;
      // Already going where it should: leave the flight alone rather than
      // cancelling it, which would drop the card into place on the spot.
      if (Math.abs(dx) < 1 && Math.abs(dy) < 1) continue;

      running.get(item)?.cancel();
      running.set(item, item.animate(
        [{ transform: `translate3d(${dx}px, ${dy}px, 0)` }, { transform: 'translate3d(0, 0, 0)' }],
        { duration: DURATION, easing: EASING },
      ));
    }
  }, [row, order]);
}
