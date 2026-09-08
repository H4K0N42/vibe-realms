import { useState } from 'react';

import { SUITS, type CardId, type ClientMessage } from '@fr/shared';

import { cardsById } from '../cards.ts';
import type { Dictionary } from '../i18n.ts';

/** Book of Changes is the one card that needs a second answer (a suit). */
const NEEDS_SUIT = new Set(['FR49']);

interface Props {
  /** Cards that still need an answer. */
  hand: CardId[];
  dict: Dictionary;
  answered: Record<CardId, boolean>;
  send: (m: ClientMessage) => void;
  /** Cards offered as targets. Defaults to `hand`. */
  targets?: CardId[];
}

/**
 * Some cards ask their holder a question when the hand is scored -- Island picks
 * a Flood or Flame to spare, Book of Changes retypes a card, Doppelganger and
 * Mirage copy one. Scoring waits until every connected holder has answered.
 */
export function ActionChoices({ hand, dict, answered, send, targets }: Props) {
  const choices = targets ?? hand;
  const pending = hand.filter((id) => !answered[id] && (targets ? true : cardsById[id]?.action));
  if (pending.length === 0) return null;
  return (
    <aside className="actions">
      <h2>Karten mit Wahl</h2>
      {pending.map((id) => (
        <ActionChoice key={id} cardId={id} hand={choices} dict={dict} send={send} />
      ))}
    </aside>
  );
}

function ActionChoice({ cardId, hand, dict, send }: {
  cardId: CardId; hand: CardId[]; dict: Dictionary; send: (m: ClientMessage) => void;
}) {
  const [target, setTarget] = useState('');
  const [suit, setSuit] = useState('');
  const needsSuit = NEEDS_SUIT.has(cardId);
  const ready = target !== '' && (!needsSuit || suit !== '');
  const text = dict.card(cardId);

  return (
    <div className="action-choice">
      <strong>{text.name}</strong>
      {text.action ? <p className="hint">{text.action}</p> : null}
      <div className="row">
        <select value={target} onChange={(e) => setTarget(e.target.value)}>
          <option value="">– Karte wählen –</option>
          {hand.filter((id) => id !== cardId).map((id) => (
            <option key={id} value={id}>{dict.card(id).name}</option>
          ))}
        </select>
        {needsSuit ? (
          <select value={suit} onChange={(e) => setSuit(e.target.value)}>
            <option value="">– Gattung –</option>
            {SUITS.map((s) => <option key={s} value={s}>{dict.ui(`suit.${s}`, s)}</option>)}
          </select>
        ) : null}
        <button className="primary" disabled={!ready}
                onClick={() => send({ t: 'resolveAction', cardId, choice: needsSuit ? [target, suit] : [target] })}>
          Bestätigen
        </button>
        <button onClick={() => send({ t: 'resolveAction', cardId, choice: null })}>
          Nicht nutzen
        </button>
      </div>
    </div>
  );
}
