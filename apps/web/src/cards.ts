// Static card definitions are public rulebook data, so they ship in the client
// bundle: the UI renders instantly and the optional score preview needs no round
// trip. The shuffled deck and other players' hands stay on the server.
import cards from '@fr/carddata/cards';
import harm from '@fr/carddata/harm';

export interface WebCardDef {
  id: string;
  set: string;
  suit: string;
  name: string;
  strength: number;
  bonus: boolean;
  penalty: boolean;
  action: boolean;
  replaces?: string;
  cursedItem?: boolean;
  /** Suits this card's text refers to. */
  relatedSuits: string[];
  /** Upstream ENGLISH names this card's text refers to. */
  relatedCards: string[];
}

export const allCards = cards as WebCardDef[];

export const cardsById: Record<string, WebCardDef> = Object.fromEntries(
  allCards.map((c) => [c.id, c]),
);

/**
 * Which cards each card damages, worked out by scoring pairs against the real
 * engine (scripts/compute-harm.mjs) rather than read off the rules text.
 * Text cannot tell "BLANKS all Floods" from "BLANKS all cards EXCEPT Flames":
 * the second names the survivors, and guessing gets it visibly wrong.
 */
export const harmedBy: Record<string, string[]> = harm as Record<string, string[]>;

/**
 * Does `other` matter to `subject`? Upstream records these links so its own UI
 * can highlight connections; we use them to light up the cards a freshly
 * revealed card interacts with. Checked both ways: Forest cares about Beasts,
 * and a Beast is just as relevant when the Forest is already on the table.
 */
export function isRelated(subjectId: string, otherId: string): boolean {
  const a = cardsById[subjectId];
  const b = cardsById[otherId];
  if (!a || !b || a.id === b.id) return false;
  return (
    a.relatedSuits.includes(b.suit) ||
    a.relatedCards.includes(b.name) ||
    b.relatedSuits.includes(a.suit) ||
    b.relatedCards.includes(a.name)
  );
}
