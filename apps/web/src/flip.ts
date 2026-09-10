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
// A spring, not a curve. Both earlier attempts were beziers and both were wrong
// in the same way: front loaded, the row snapped shut and crept the rest of the
// way; eased at both ends, it was simply slow. What the movement wants is to
// arrive quickly, go a little past and come back, which no bezier does and a
// spring does for free.
//
// Slightly underdamped, so the overshoot is a few percent of however far the
// card had to travel: a card moving one place along tips past it by a handful of
// pixels, and one crossing the whole hand by a little more, which is what makes
// a big rearrangement feel like it carried some weight.
const SPRING_K = 1100;
const SPRING_ZETA = 0.68;
const SAMPLE_MS = 10;

/**
 * The spring's progress from 0 (where the card was) to 1 (where it belongs),
 * sampled onto an even grid so it can be handed to the animation as keyframes.
 * Sampled once: the shape does not depend on how far any particular card has to
 * go, only the distance it gets multiplied by does.
 */
function springProgress(k: number, zeta: number): number[] {
  const c = 2 * Math.sqrt(k) * zeta;
  const step = 1 / 600;
  const perSample = Math.round((SAMPLE_MS / 1000) / step);
  const out = [0];
  let p = 0;
  let v = 0;
  // Long enough for this spring to be over, and capped so a bad constant cannot
  // produce an animation that outlives the drag it belongs to.
  for (let i = 1; i <= 60 * perSample; i++) {
    v += (-k * (p - 1) - c * v) * step;
    p += v * step;
    if (i % perSample === 0) {
      out.push(p);
      // Arrived and stopped moving: everything after this is invisible.
      if (Math.abs(1 - p) < 0.002 && Math.abs(v) < 0.06) break;
    }
  }
  out[out.length - 1] = 1;
  return out;
}

const PROGRESS = springProgress(SPRING_K, SPRING_ZETA);
const DURATION = (PROGRESS.length - 1) * SAMPLE_MS;

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
        PROGRESS.map((p, i) => ({
          offset: i / (PROGRESS.length - 1),
          transform: `translate3d(${dx * (1 - p)}px, ${dy * (1 - p)}px, 0)`,
        })),
        // Linear between samples: the shape is in the samples themselves, and
        // any easing on top of them would be a second opinion about the timing.
        { duration: DURATION, easing: 'linear' },
      ));
    }
  }, [row, order]);
}
