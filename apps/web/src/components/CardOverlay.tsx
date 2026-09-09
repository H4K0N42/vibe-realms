import { useEffect, useRef } from 'react';

import type { CardId } from '@fr/shared';

import type { Dictionary } from '../i18n.ts';
import { Card } from './Card.tsx';

/**
 * One card, big, with its rules text in full.
 *
 * The cards on the table have a fixed aspect ratio, so a long text (Jewel of
 * Order, Phoenix) is cut off. On a mouse that is covered by growing the card on
 * hover, but hover does not exist on a touch screen and cannot be reached
 * from the keyboard, which left that text genuinely unreadable. A tap or Space
 * opens this instead.
 */
export function CardOverlay({ id, dict, onClose }: {
  id: CardId; dict: Dictionary; onClose: () => void;
}) {
  const closeButton = useRef<HTMLButtonElement>(null);
  const returnFocusTo = useRef<Element | null>(null);

  useEffect(() => {
    returnFocusTo.current = document.activeElement;
    closeButton.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
      // Back to the card that was opened, so tabbing carries on where it was.
      (returnFocusTo.current as HTMLElement | null)?.focus?.();
    };
  }, [onClose]);

  return (
    <div className="card-overlay" onClick={onClose}>
      {/* The card itself is not a click target for closing: dragging a finger
          across the text should not dismiss what you are reading. */}
      <div className="card-overlay-inner" onClick={(e) => e.stopPropagation()}
           role="dialog" aria-modal="true" aria-label={dict.card(id).name}>
        <Card id={id} dict={dict} />
        <button ref={closeButton} className="primary" onClick={onClose}>
          {dict.t('card.close')}
        </button>
      </div>
    </div>
  );
}
