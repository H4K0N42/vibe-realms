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
const FOLLOW_C = 2 * Math.sqrt(FOLLOW_K) * 0.7;
// The flight home is stiffer, and how damped it is depends on how hard the card
// was thrown: set down gently it is exactly critical and simply arrives, thrown
// across the table it is loose enough to go slightly past its place and come
// back. Both ends are deliberately understated. A card that visibly boings has
// stopped being a card and started being a demo of a spring.
const LAND_K = 1500;
const LAND_ZETA_STILL = 1;
const LAND_ZETA_THROWN = 0.7;
const THROW_SPEED = 2600;  // px/s at which the landing is at its loosest, which is
                           // fast enough that an ordinary drag never gets there
const STEP = 1 / 240;     // sub-steps, so one long frame cannot blow a spring up
const MAX_FRAME = 0.05;   // ...and neither can a tab returning from the background

const LIFT_SCALE = 1.06;  // how much bigger the card is once it is off the table
// The size settles on its own spring, always critically damped: a card that
// throbs while it is being carried looks like a mistake, whatever the position
// underneath it is doing.
const LIFT_K = 1500;
const LIFT_C = 2 * Math.sqrt(LIFT_K);
const TILT_PER_PX = 0.09; // degrees of tilt per pixel the card trails behind
const TILT_MAX = 9;
const MAGNET = 0.55;      // how far towards the landing place the card is pulled
// ...and from how far away, as a multiple of the card's own width, so it scales
// with the layout instead of with the screen. The discard area is one
// destination for a whole corner of the table, so a card starts homing in on it
// from a long way off.
const REACH_TO_DISCARD = 2.5;

// A card sitting in a gap in the hand behaves differently from one being drawn
// towards a target: it is *in* a place, and it stays there. The pull holds
// nearly firm until the pointer has been dragged most of a cell away and then
// gives out, at exactly the distance the gap itself moves along. So a card
// clings to the row, strains, comes loose and drops into the next place, rather
// than sliding continuously through positions it was never really in.
const STICK_PULL = 0.68;
// A throw is not a rearrangement. Detents are for putting a card down in a
// particular place; a hand already moving has decided, and being caught by every
// cell it passes over is what makes a fling feel like it is dragging through
// gravel. So the hold fades out with how fast the pointer is travelling, and a
// card on its way out of the hand simply leaves. Both speeds are of the pointer,
// not of the card: the card is the thing being held back, so asking it how fast
// it is going would be asking the stick to judge itself.
const STICK_FULL_BELOW = 260;   // px/s, an unhurried drag between places
const STICK_GONE_ABOVE = 1100;  // px/s, unmistakably a throw
const DETACH = 0.6;       // in cells, and necessarily more than half of one:
                          // below that the card could break loose into a place
                          // it is already close enough to break straight out of.
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
  /** Last frame's pointer, and the smoothed speed between them. */
  lastPointerX: number;
  lastPointerY: number;
  pointerSpeed: number;
  posX: number;
  posY: number;
  velX: number;
  velY: number;
  lagX: number;
  scale: number;
  scaleVel: number;
  /** Reduced motion: the card is placed rather than thrown, with no flight home. */
  calm: boolean;
  /** The cell of the hand it is currently in, which it keeps until dragged clear. */
  handIndex: number | null;
  /** Damping of the flight home, fixed at release from how fast it was moving. */
  landC: number;
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

interface Landing { x: number; y: number; reach: number; sticky: boolean; }

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

const centreOf = (b: DOMRect) => ({ x: b.left + b.width / 2, y: b.top + b.height / 2 });
const reachOf = (b: DOMRect, x: number, y: number) => {
  const c = centreOf(b);
  return Math.hypot(x - c.x, y - c.y);
};
/** Centre to centre along the row, which is what "a cell away" means. */
const pitchOf = (boxes: DOMRect[]) =>
  boxes.length > 1 ? Math.abs(centreOf(boxes[1]!).x - centreOf(boxes[0]!).x) : boxes[0]!.width;

/**
 * Which place in the hand the pointer is asking for.
 *
 * Measured in layout space (see `layoutBox`): the cells are fixed, so the answer
 * depends on the pointer and on which cell the card is already in, and on
 * nothing else. Reading the drawn positions instead would mean the row's own
 * sliding decided where the next slide goes.
 */
function indexInHand(x: number, y: number, previous: number | null): number | null {
  const slots = [...document.querySelectorAll<HTMLElement>('[data-hand-slot]')];
  if (!slots.length) return null;
  const boxes = slots.map(layoutBox);

  // Rearranging within the hand: the previewed row already holds a cell for this
  // card, so the question is not where to insert it but which cell it wants, and
  // it keeps the one it has until dragged clear of it. Distance is measured in
  // both axes, because a narrow window wraps the row into two.
  if (document.querySelector('[data-drag-placeholder]')) {
    const held = previous !== null && previous < boxes.length ? boxes[previous]! : null;
    if (held && reachOf(held, x, y) < pitchOf(boxes) * DETACH) return previous;
    let cell = 0;
    let nearest = Infinity;
    boxes.forEach((b, i) => {
      const d = reachOf(b, x, y);
      if (d < nearest) { nearest = d; cell = i; }
    });
    return cell;
  }

  // Coming in from the draw pile or the discard: nothing is holding a place yet,
  // so this is an insertion point between cards, and it can be one past the end.
  let bestIndex = -1;
  let bestDistance = Infinity;
  let bestBox: DOMRect | null = null;
  boxes.forEach((b, i) => {
    // Horizontal distance to the slot's centre: the hand is a row, so x decides.
    const d = Math.abs(x - centreOf(b).x) + (y < b.top - 80 ? 400 : 0);
    if (d < bestDistance) {
      bestDistance = d;
      bestIndex = i;
      bestBox = b;
    }
  });
  if (bestIndex === -1 || !bestBox) return null;
  const box: DOMRect = bestBox;
  // Past the middle of the nearest slot means "after it".
  return x > centreOf(box).x ? bestIndex + 1 : bestIndex;
}

/**
 * The top left corner of the place this card would occupy if it were let go
 * now, read off the live layout, or null when the pointer is over nothing that
 * would take it. This is the one thing both the magnet and the flight home need
 * to know, so they ask the same question and always agree on the answer.
 */
function landingSpot(from: Zone, over: Zone | null, cardWidth: number): Landing | null {
  if (over === 'hand') {
    const slots = [...document.querySelectorAll<HTMLElement>('[data-hand-slot]')];
    if (!slots.length) return null;

    // The gap. Not calculated: it is literally the place the row is holding
    // open, whether that is the faded card being rearranged or the outline the
    // hand opens for one arriving from elsewhere. So the stick can never
    // disagree with what is on screen. Its reach is the distance at which the
    // gap moves along, so the hold gives out exactly as the place it holds to
    // changes hands.
    const preview = document.querySelector<HTMLElement>('[data-drag-placeholder]');
    if (!preview) {
      // No gap open means the hand is not offering this card a place: the draw
      // would be refused, and pulling towards a place it cannot take would
      // promise something that is not going to happen.
      return null;
    }
    const r = layoutBox(preview);
    return { x: r.left, y: r.top, reach: pitchOf(slots.map(layoutBox)) * DETACH, sticky: true };
  }
  // Only a card from the hand can be discarded, which is the same condition the
  // zone highlight uses; pulling towards a move that will be refused would lie.
  if (over === 'discard' && from === 'hand') {
    const empty = document.querySelector<HTMLElement>('[data-zone="discard"] .card-empty');
    if (!empty) return null;
    const r = empty.getBoundingClientRect();
    return { x: r.left, y: r.top, reach: cardWidth * REACH_TO_DISCARD, sticky: false };
  }
  return null;
}

const tiltOf = (lag: number) =>
  Math.max(-TILT_MAX, Math.min(TILT_MAX, lag * TILT_PER_PX));

/** How much of the hold is left at this pointer speed: all of it, or none. */
function escapedBy(speed: number): number {
  const t = Math.min(1, Math.max(0, (speed - STICK_FULL_BELOW) / (STICK_GONE_ABOVE - STICK_FULL_BELOW)));
  return 1 - t * t * (3 - 2 * t);
}

function pullAt(distance: number, reach: number, sticky: boolean): number {
  const t = Math.min(1, distance / reach);
  // Holding on: nearly constant for most of the way out, then it lets go over
  // the last stretch, which is what makes breaking a card out of its place
  // something you feel rather than something that merely happens.
  if (sticky) return STICK_PULL * (1 - t ** 4);
  // Being drawn in: smoothstep, so the magnet has no edge to it and instead
  // fades in as the card approaches from arm's length.
  const u = 1 - t;
  return MAGNET * u * u * (3 - 2 * u);
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

    // Measured here rather than in the move handler, so it is over a known and
    // even interval instead of over whatever gaps the pointer events arrive in.
    const travelled = Math.hypot(g.pointerX - g.lastPointerX, g.pointerY - g.lastPointerY);
    g.lastPointerX = g.pointerX;
    g.lastPointerY = g.pointerY;
    g.pointerSpeed += (travelled / Math.max(dt, 1 / 1000) - g.pointerSpeed) * Math.min(1, dt * 18);

    // Held still for long enough? Break loose without any movement, the way a
    // long press picks up an icon.
    if (!g.lifted && !g.releasedAt && now - g.startedAt >= LIFT_MS) g.lifted = true;

    // One hit test per frame, shared by the magnet and by what gets published:
    // both have to agree about which zone the pointer is over.
    const hit = g.lifted && !g.releasedAt ? zoneUnder(g.pointerX, g.pointerY) : null;
    const over = hit?.zone ?? null;
    const overIndex = over === 'hand' ? indexInHand(g.pointerX, g.pointerY, g.handIndex) : null;
    // Kept on the grab, so the cell it is in survives from frame to frame and
    // dropping uses the very place that was last drawn rather than asking again.
    g.handIndex = overIndex;

    if (g.lifted) {
      const landing = g.releasedAt
        ? { x: g.landX, y: g.landY, reach: 0, sticky: false }
        : landingSpot(g.from, over, g.width);

      // Under the pointer by its middle: the card gathers itself into the hand
      // that picked it up rather than hanging off the corner that was grabbed.
      let targetX = g.pointerX - g.width / 2;
      let targetY = g.pointerY - g.height / 2;
      if (landing) {
        const pull = g.releasedAt
          ? 1
          : pullAt(Math.hypot(landing.x - targetX, landing.y - targetY), landing.reach, landing.sticky) *
            (landing.sticky ? escapedBy(g.pointerSpeed) : 1);
        targetX += (landing.x - targetX) * pull;
        targetY += (landing.y - targetY) * pull;
      }

      if (g.calm) {
        g.posX = targetX; g.posY = targetY; g.velX = 0; g.velY = 0; g.lagX = 0; g.scale = 1;
      } else {
        const k = g.releasedAt ? LAND_K : FOLLOW_K;
        const c = g.releasedAt ? g.landC : FOLLOW_C;
        [g.posX, g.velX] = spring(g.posX, g.velX, targetX, dt, k, c);
        [g.posY, g.velY] = spring(g.posY, g.velY, targetY, dt, k, c);
        // The tilt is the lag itself, smoothed: a card trailing 100px behind a
        // fast hand tips as far as it goes, and a card at rest is straight.
        g.lagX += ((targetX - g.posX) - g.lagX) * Math.min(1, dt * 14);
        [g.scale, g.scaleVel] =
          spring(g.scale, g.scaleVel, g.releasedAt ? 1 : LIFT_SCALE, dt, LIFT_K, LIFT_C);
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
        lastPointerX: e.clientX, lastPointerY: e.clientY, pointerSpeed: 0,
        posX: r.left, posY: r.top,
        velX: 0, velY: 0, lagX: 0,
        scale: 1, scaleVel: 0, calm: reducedMotion(),
        handIndex: null, landC: 2 * Math.sqrt(LAND_K),
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
      // The cell the last frame drew, not a fresh answer: what you saw when you
      // let go is where it goes.
      const index = to === 'hand'
        ? g.handIndex ?? indexInHand(g.pointerX, g.pointerY, null)
        : null;
      // How hard it was thrown decides how loose the landing is.
      const thrown = Math.min(1, Math.hypot(g.velX, g.velY) / THROW_SPEED);
      g.landC = 2 * Math.sqrt(LAND_K) *
        (LAND_ZETA_STILL + (LAND_ZETA_THROWN - LAND_ZETA_STILL) * thrown);
      // Where to fly, decided before the move is reported: afterwards the row
      // has already been rearranged and the question no longer has this answer.
      // A refused drop goes back to the card it came from, which is still there.
      const home = landingSpot(g.from, to, g.width) ??
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
