import { useCallback, useEffect, useRef, useState } from 'react';

import type { CardId } from '@fr/shared';

import { layoutBox } from './flip.ts';

export type Zone = 'hand' | 'discard' | 'deck';

/**
 * The feel of a drag, in the shape iOS gives it: the card resists for a moment,
 * then breaks loose and glides under the pointer, trails slightly behind a fast
 * hand, is pulled the last stretch into the place it would land, and flies into
 * that place when let go instead of blinking out of existence.
 *
 * Everything after the lift is one spring per axis, integrated against real
 * elapsed time. What was here before ("move 26% of the remaining distance every
 * frame") was neither: it settled twice as fast on a 120Hz screen as on a 60Hz
 * one, and an exponential approach has no snap in it, only a long tail.
 */
const LIFT_MS = 190;      // held this long: it breaks loose on its own
const LIFT_DIST = 16;     // ...or moved this far

// Stiffness in 1/s^2, damping in 1/s. Damping is written as a fraction of
// critical: just under 1 settles in about 150ms with an overshoot too small to
// see, which is the snappy end of the range rather than the springy one.
const FOLLOW_K = 900;
const FOLLOW_C = 2 * Math.sqrt(FOLLOW_K) * 0.82;
// The flight home is stiffer and exactly critical: it hands over to the real
// card sitting in that place, and a bounce there would read as two cards.
const LAND_K = 1500;
const LAND_C = 2 * Math.sqrt(LAND_K);
const STEP = 1 / 240;     // sub-steps, so one long frame cannot blow a spring up
const MAX_FRAME = 0.05;   // ...and neither can a tab returning from the background

const LIFT_SCALE = 1.06;  // how much bigger the card is once it is off the table
const TILT_PER_PX = 0.09; // degrees of tilt per pixel the card trails behind
const TILT_MAX = 9;
const MAGNET = 0.55;      // how far towards the landing place the card is pulled
// ...and from how far away, as a multiple of the card's own width, so it scales
// with the layout instead of with the screen. A gap in the hand is already
// under the pointer and only wants a nudge; the discard area is one destination
// for a whole corner of the table, so the card starts homing in much earlier.
const REACH_IN_HAND = 1.5;
const REACH_TO_DISCARD = 2.5;
const LAND_MS = 220;      // ...and how long it takes to get there on release

// Asked once per grab rather than once per frame, and read again next time so
// that changing the system setting mid-session still takes effect.
const reducedMotion = () =>
  typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;

export interface DragState {
  /** null while dragging the face-down draw pile. */
  cardId: CardId | null;
  from: Zone;
  lifted: boolean;
  x: number;
  y: number;
  width: number;
  height: number;
  /** Spring outputs for the ghost: the lift eases in, the tilt comes from lag. */
  scale: number;
  tilt: number;
  opacity: number;
  /** The pointer is already up and the ghost is only flying to where it landed. */
  settling: boolean;
  over: Zone | null;
  /** Insertion point while rearranging the hand. */
  overIndex: number | null;
}

interface Grab {
  cardId: CardId | null;
  from: Zone;
  el: HTMLElement;
  startX: number;
  startY: number;
  width: number;
  height: number;
  startedAt: number;
  lifted: boolean;
  pointerX: number;
  pointerY: number;
  posX: number;
  posY: number;
  velX: number;
  velY: number;
  lagX: number;
  scale: number;
  scaleVel: number;
  /** Reduced motion: the card is placed rather than thrown, with no flight home. */
  calm: boolean;
  /** Set on release; from then on the springs aim at `landX/landY` and fade. */
  releasedAt: number;
  landX: number;
  landY: number;
  lastFrame: number;
}

export interface DropResult {
  cardId: CardId | null;
  from: Zone;
  to: Zone | null;
  /** Where in the hand it was dropped, when the target is the hand. */
  index: number | null;
}

interface Landing { x: number; y: number; reach: number; }

function zoneUnder(x: number, y: number): { zone: Zone; el: Element } | null {
  const zones = document.querySelectorAll<HTMLElement>('[data-zone]');
  for (const el of zones) {
    const r = el.getBoundingClientRect();
    if (x >= r.left && x <= r.right && y >= r.top && y <= r.bottom) {
      return { zone: el.dataset.zone as Zone, el };
    }
  }
  return null;
}

/**
 * Which gap in the hand the pointer is asking for. Measured in layout space
 * (see `layoutBox`): the cells this compares against are fixed, so the answer
 * depends on the pointer and nothing else. Reading the drawn positions instead
 * would mean the row's own sliding decided where the next slide goes.
 */
function indexInHand(x: number, y: number): number | null {
  const slots = document.querySelectorAll<HTMLElement>('[data-hand-slot]');
  if (!slots.length) return null;
  let bestIndex = -1;
  let bestDistance = Infinity;
  let bestBox: DOMRect | null = null;
  slots.forEach((el, i) => {
    const r = layoutBox(el);
    // Horizontal distance to the slot's centre: the hand is a row, so x decides.
    const d = Math.abs(x - (r.left + r.width / 2)) + (y < r.top - 80 ? 400 : 0);
    if (d < bestDistance) {
      bestDistance = d;
      bestIndex = i;
      bestBox = r;
    }
  });
  if (bestIndex === -1 || !bestBox) return null;
  const r: DOMRect = bestBox;
  // Past the middle of the nearest slot means "after it".
  return x > r.left + r.width / 2 ? bestIndex + 1 : bestIndex;
}

/**
 * The top left corner of the place this card would occupy if it were let go
 * now, read off the live layout, or null when the pointer is over nothing that
 * would take it. This is the one thing both the magnet and the flight home need
 * to know, so they ask the same question and always agree on the answer.
 */
function landingSpot(
  from: Zone, over: Zone | null, overIndex: number | null, cardWidth: number,
): Landing | null {
  if (over === 'hand') {
    // While rearranging, the hand already shows the gap: the faded card sitting
    // in the previewed order IS the landing place, so no arithmetic is needed
    // and the magnet cannot disagree with what the row is showing.
    const reach = cardWidth * REACH_IN_HAND;
    const preview = document.querySelector<HTMLElement>('[data-drag-placeholder]');
    if (preview) {
      const r = layoutBox(preview);
      return { x: r.left, y: r.top, reach };
    }
    const slots = [...document.querySelectorAll<HTMLElement>('[data-hand-slot]')];
    if (!slots.length) return null;
    const at = Math.min(Math.max(overIndex ?? slots.length, 0), slots.length);
    if (at < slots.length) {
      const r = layoutBox(slots[at]!);
      return { x: r.left, y: r.top, reach };
    }
    // Coming from outside the hand and landing at the end: one place further
    // along the row, measured rather than assumed.
    const last = layoutBox(slots[slots.length - 1]!);
    const gap = slots.length > 1
      ? layoutBox(slots[1]!).left - layoutBox(slots[0]!).right
      : 6;
    return { x: last.right + gap, y: last.top, reach };
  }
  // Only a card from the hand can be discarded, which is the same condition the
  // zone highlight uses; pulling towards a move that will be refused would lie.
  if (over === 'discard' && from === 'hand') {
    const empty = document.querySelector<HTMLElement>('[data-zone="discard"] .card-empty');
    if (!empty) return null;
    const r = empty.getBoundingClientRect();
    return { x: r.left, y: r.top, reach: cardWidth * REACH_TO_DISCARD };
  }
  return null;
}

const tiltOf = (lag: number) =>
  Math.max(-TILT_MAX, Math.min(TILT_MAX, lag * TILT_PER_PX));

/** Smoothstep, so the magnet has no edge to it: it fades in at arm's length. */
function pullAt(distance: number, reach: number): number {
  const t = 1 - Math.min(1, distance / reach);
  return MAGNET * t * t * (3 - 2 * t);
}

function spring(pos: number, vel: number, target: number, dt: number, k: number, c: number) {
  let p = pos;
  let v = vel;
  for (let left = dt; left > 0; left -= STEP) {
    const h = Math.min(STEP, left);
    v += (-k * (p - target) - c * v) * h;
    p += v * h;
  }
  return [p, v] as const;
}

/** Whether the ghost moved enough to be worth another render. */
function same(a: DragState, b: DragState): boolean {
  return a.cardId === b.cardId && a.lifted === b.lifted && a.settling === b.settling &&
    a.over === b.over && a.overIndex === b.overIndex &&
    Math.abs(a.x - b.x) < 0.2 && Math.abs(a.y - b.y) < 0.2 &&
    Math.abs(a.scale - b.scale) < 0.002 && Math.abs(a.tilt - b.tilt) < 0.05 &&
    Math.abs(a.opacity - b.opacity) < 0.01;
}

export function useDragEngine(onDrop: (result: DropResult) => void) {
  const grab = useRef<Grab | null>(null);
  const raf = useRef(0);
  const shown = useRef<DragState | null>(null);
  const [drag, setDrag] = useState<DragState | null>(null);

  const publish = useCallback((next: DragState | null) => {
    if (next && shown.current && same(shown.current, next)) return;
    shown.current = next;
    setDrag(next);
  }, []);

  const stop = useCallback(() => {
    cancelAnimationFrame(raf.current);
    raf.current = 0;
    grab.current = null;
    shown.current = null;
    setDrag(null);
  }, []);

  const frame = useCallback(() => {
    const g = grab.current;
    if (!g) return;
    const now = performance.now();
    const dt = Math.min(MAX_FRAME, (now - g.lastFrame) / 1000);
    g.lastFrame = now;

    // Held still for long enough? Break loose without any movement, the way a
    // long press picks up an icon.
    if (!g.lifted && !g.releasedAt && now - g.startedAt >= LIFT_MS) g.lifted = true;

    // One hit test per frame, shared by the magnet and by what gets published:
    // both have to agree about which zone the pointer is over.
    const hit = g.lifted && !g.releasedAt ? zoneUnder(g.pointerX, g.pointerY) : null;
    const over = hit?.zone ?? null;
    const overIndex = over === 'hand' ? indexInHand(g.pointerX, g.pointerY) : null;

    if (g.lifted) {
      const landing = g.releasedAt
        ? { x: g.landX, y: g.landY, reach: 0 }
        : landingSpot(g.from, over, overIndex, g.width);

      // Under the pointer by its middle: the card gathers itself into the hand
      // that picked it up rather than hanging off the corner that was grabbed.
      let targetX = g.pointerX - g.width / 2;
      let targetY = g.pointerY - g.height / 2;
      if (landing) {
        const pull = g.releasedAt
          ? 1
          : pullAt(Math.hypot(landing.x - targetX, landing.y - targetY), landing.reach);
        targetX += (landing.x - targetX) * pull;
        targetY += (landing.y - targetY) * pull;
      }

      if (g.calm) {
        g.posX = targetX; g.posY = targetY; g.velX = 0; g.velY = 0; g.lagX = 0; g.scale = 1;
      } else {
        const k = g.releasedAt ? LAND_K : FOLLOW_K;
        const c = g.releasedAt ? LAND_C : FOLLOW_C;
        [g.posX, g.velX] = spring(g.posX, g.velX, targetX, dt, k, c);
        [g.posY, g.velY] = spring(g.posY, g.velY, targetY, dt, k, c);
        // The tilt is the lag itself, smoothed: a card trailing 100px behind a
        // fast hand tips as far as it goes, and a card at rest is straight.
        g.lagX += ((targetX - g.posX) - g.lagX) * Math.min(1, dt * 14);
        [g.scale, g.scaleVel] =
          spring(g.scale, g.scaleVel, g.releasedAt ? 1 : LIFT_SCALE, dt, LAND_K, LAND_C);
      }
    }

    if (g.releasedAt) {
      // The ghost fades as it arrives and the real card underneath takes over.
      const done = Math.min(1, (now - g.releasedAt) / LAND_MS);
      if (done >= 1) {
        stop();
        return;
      }
      publish({
        cardId: g.cardId, from: g.from, lifted: true,
        x: g.posX, y: g.posY, width: g.width, height: g.height,
        scale: g.scale, tilt: tiltOf(g.lagX),
        opacity: 1 - done * done, settling: true,
        over: null, overIndex: null,
      });
    } else if (g.lifted) {
      publish({
        cardId: g.cardId, from: g.from, lifted: true,
        x: g.posX, y: g.posY, width: g.width, height: g.height,
        scale: g.scale, tilt: tiltOf(g.lagX),
        opacity: 1, settling: false, over, overIndex,
      });
    }
    raf.current = requestAnimationFrame(frame);
  }, [publish, stop]);

  const begin = useCallback(
    (cardId: CardId | null, from: Zone) => (e: React.PointerEvent) => {
      if (e.button !== undefined && e.button !== 0) return;
      const el = e.currentTarget as HTMLElement;
      const r = el.getBoundingClientRect();
      grab.current = {
        cardId, from, el,
        startX: e.clientX, startY: e.clientY,
        width: r.width, height: r.height,
        startedAt: performance.now(), lifted: false,
        pointerX: e.clientX, pointerY: e.clientY,
        posX: r.left, posY: r.top,
        velX: 0, velY: 0, lagX: 0,
        scale: 1, scaleVel: 0, calm: reducedMotion(),
        releasedAt: 0, landX: 0, landY: 0,
        lastFrame: performance.now(),
      };
      if (!raf.current) raf.current = requestAnimationFrame(frame);
    },
    [frame],
  );

  // Listeners live on the window while a card is held: a drag crosses zones and
  // frequently leaves the element it started on.
  useEffect(() => {
    const move = (e: PointerEvent) => {
      const g = grab.current;
      if (!g || g.releasedAt) return;
      g.pointerX = e.clientX;
      g.pointerY = e.clientY;
      const dist = Math.hypot(e.clientX - g.startX, e.clientY - g.startY);
      if (!g.lifted && dist >= LIFT_DIST) g.lifted = true;
      if (g.lifted) e.preventDefault();
    };
    const up = () => {
      const g = grab.current;
      if (!g || g.releasedAt) return;
      if (!g.lifted) {
        // Never broke loose: treat as a tap, which callers may ignore.
        stop();
        onDrop({ cardId: g.cardId, from: g.from, to: null, index: null });
        return;
      }
      const hit = zoneUnder(g.pointerX, g.pointerY);
      const to = hit?.zone ?? null;
      const index = to === 'hand' ? indexInHand(g.pointerX, g.pointerY) : null;
      // Where to fly, decided before the move is reported: afterwards the row
      // has already been rearranged and the question no longer has this answer.
      // A refused drop goes back to the card it came from, which is still there.
      const home = landingSpot(g.from, to, index, g.width) ??
        (g.el.isConnected
          ? (() => { const r = g.el.getBoundingClientRect(); return { x: r.left, y: r.top }; })()
          : { x: g.posX, y: g.posY });
      g.landX = home.x;
      g.landY = home.y;
      g.releasedAt = performance.now();
      if (g.calm) stop();
      // Reported straight away, not after the flight: the move is the point and
      // waiting on an animation for it is what makes an interface feel slow.
      onDrop({ cardId: g.cardId, from: g.from, to, index });
    };
    window.addEventListener('pointermove', move, { passive: false });
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', up);
    return () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', up);
    };
  }, [onDrop, stop]);

  useEffect(() => stop, [stop]);

  return { drag, begin };
}
