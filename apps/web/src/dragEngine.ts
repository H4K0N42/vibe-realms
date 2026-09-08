import { useCallback, useEffect, useRef, useState } from 'react';

import type { CardId } from '@fr/shared';

export type Zone = 'hand' | 'discard' | 'deck';

/**
 * Feel of the drag, tuned to behave like moving an app window on iOS: the card
 * resists for a moment, then breaks loose, snaps under the finger and follows
 * with a little weight rather than sticking rigidly to the cursor.
 */
const LIFT_MS = 190;      // held this long -> it breaks loose on its own
const LIFT_DIST = 16;     // ...or moved this far
const SNAP_MS = 170;      // grab point slides to the card's middle
const FOLLOW = 0.26;      // per-frame catch-up; lower = heavier

export interface DragState {
  /** null while dragging the face-down draw pile. */
  cardId: CardId | null;
  from: Zone;
  lifted: boolean;
  x: number;
  y: number;
  width: number;
  height: number;
  over: Zone | null;
  /** Insertion point while rearranging the hand. */
  overIndex: number | null;
}

interface Grab {
  cardId: CardId | null;
  from: Zone;
  startX: number;
  startY: number;
  offsetX: number;
  offsetY: number;
  centreX: number;
  centreY: number;
  width: number;
  height: number;
  startedAt: number;
  lifted: boolean;
  liftedAt: number;
  pointerX: number;
  pointerY: number;
  posX: number;
  posY: number;
  moved: boolean;
}

export interface DropResult {
  cardId: CardId | null;
  from: Zone;
  to: Zone | null;
  /** Where in the hand it was dropped, when the target is the hand. */
  index: number | null;
}

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

function indexInHand(x: number, y: number): number | null {
  const slots = document.querySelectorAll<HTMLElement>('[data-hand-slot]');
  if (!slots.length) return null;
  let bestIndex = -1;
  let bestDistance = Infinity;
  slots.forEach((el, i) => {
    const r = el.getBoundingClientRect();
    // Horizontal distance to the slot's centre: the hand is a row, so x decides.
    const d = Math.abs(x - (r.left + r.width / 2)) + (y < r.top - 80 ? 400 : 0);
    if (d < bestDistance) {
      bestDistance = d;
      bestIndex = i;
    }
  });
  if (bestIndex === -1) return null;
  const r = slots[bestIndex]!.getBoundingClientRect();
  // Past the middle of the nearest slot means "after it".
  return x > r.left + r.width / 2 ? bestIndex + 1 : bestIndex;
}

export function useDragEngine(onDrop: (result: DropResult) => void) {
  const grab = useRef<Grab | null>(null);
  const raf = useRef(0);
  const [drag, setDrag] = useState<DragState | null>(null);

  const stop = useCallback(() => {
    cancelAnimationFrame(raf.current);
    raf.current = 0;
  }, []);

  const frame = useCallback(() => {
    const g = grab.current;
    if (!g) return;

    if (!g.lifted) {
      // Held still for long enough? Break loose without any movement, the way a
      // long press picks up an icon.
      if (performance.now() - g.startedAt >= LIFT_MS) {
        g.lifted = true;
        g.liftedAt = performance.now();
      }
    }

    if (g.lifted) {
      // Ease the grab point from wherever it was pressed to the card's middle,
      // so the card visibly snaps under the pointer instead of jumping.
      const k = Math.min(1, (performance.now() - g.liftedAt) / SNAP_MS);
      const eased = 1 - (1 - k) ** 3;
      const offX = g.offsetX + (g.width / 2 - g.offsetX) * eased;
      const offY = g.offsetY + (g.height / 2 - g.offsetY) * eased;

      const targetX = g.pointerX - offX;
      const targetY = g.pointerY - offY;
      g.posX += (targetX - g.posX) * FOLLOW;
      g.posY += (targetY - g.posY) * FOLLOW;

      const hit = zoneUnder(g.pointerX, g.pointerY);
      setDrag({
        cardId: g.cardId,
        from: g.from,
        lifted: true,
        x: g.posX,
        y: g.posY,
        width: g.width,
        height: g.height,
        over: hit?.zone ?? null,
        overIndex: hit?.zone === 'hand' ? indexInHand(g.pointerX, g.pointerY) : null,
      });
    }
    raf.current = requestAnimationFrame(frame);
  }, []);

  const begin = useCallback(
    (cardId: CardId | null, from: Zone) => (e: React.PointerEvent) => {
      if (e.button !== undefined && e.button !== 0) return;
      const el = (e.currentTarget as HTMLElement);
      const r = el.getBoundingClientRect();
      grab.current = {
        cardId, from,
        startX: e.clientX, startY: e.clientY,
        offsetX: e.clientX - r.left, offsetY: e.clientY - r.top,
        centreX: r.left + r.width / 2, centreY: r.top + r.height / 2,
        width: r.width, height: r.height,
        startedAt: performance.now(), lifted: false, liftedAt: 0,
        pointerX: e.clientX, pointerY: e.clientY,
        posX: r.left, posY: r.top,
        moved: false,
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
      if (!g) return;
      g.pointerX = e.clientX;
      g.pointerY = e.clientY;
      const dist = Math.hypot(e.clientX - g.startX, e.clientY - g.startY);
      if (dist > 3) g.moved = true;
      if (!g.lifted && dist >= LIFT_DIST) {
        g.lifted = true;
        g.liftedAt = performance.now();
      }
      if (g.lifted) e.preventDefault();
    };
    const up = () => {
      const g = grab.current;
      grab.current = null;
      stop();
      setDrag(null);
      if (!g) return;
      if (!g.lifted) {
        // Never broke loose: treat as a tap, which callers may ignore.
        onDrop({ cardId: g.cardId, from: g.from, to: null, index: null });
        return;
      }
      const hit = zoneUnder(g.pointerX, g.pointerY);
      onDrop({
        cardId: g.cardId,
        from: g.from,
        to: hit?.zone ?? null,
        index: hit?.zone === 'hand' ? indexInHand(g.pointerX, g.pointerY) : null,
      });
    };
    window.addEventListener('pointermove', move, { passive: false });
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', up);
    return () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', up);
    };
  }, [onDrop, stop, frame]);

  useEffect(() => stop, [stop]);

  return { drag, begin };
}
