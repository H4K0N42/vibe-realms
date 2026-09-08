/** Static card data. Mirrors the shape of the vendored deck.js definitions. */

export const SUITS = [
  'land', 'flood', 'weather', 'flame', 'army', 'wizard', 'leader',
  'beast', 'weapon', 'artifact', 'wild',
  // Cursed Hoard
  'building', 'outsider', 'undead', 'cursed-item',
] as const;
export type Suit = (typeof SUITS)[number];

/** e.g. 'FR01', 'FR55P', 'CH20'. */
export type CardId = string;

/**
 * A run of card effect text. Upstream stores effect text as HTML containing
 * `<span class="suit">Name</span>`; we parse it into tokens so the client can
 * render suit references with our own theme instead of upstream CSS.
 */
export type TextToken =
  | { kind: 'text'; value: string; bold?: boolean }
  | { kind: 'ref'; value: string; suit: Suit; bold?: boolean }
  | { kind: 'break' };

/** Static, public, safe to bundle into the client. */
export interface CardDef {
  id: CardId;
  suit: Suit;
  strength: number;
  /** True if the card needs a player choice when scoring (Island, Doppelgänger...). */
  action: boolean;
  /** Base card this replaces when Cursed Hoard suits are enabled, if any. */
  replaces?: CardId;
}

/** Per-language display text, keyed by card id. */
export interface CardText {
  name: string;
  bonus?: TextToken[];
  penalty?: TextToken[];
  action?: string;
}

export const LOCALES = [
  'de', 'en', 'cz', 'es', 'fr', 'it', 'kr', 'pl', 'pt', 'ru', 'ua', 'zh', 'zh_TW',
] as const;
export type Locale = (typeof LOCALES)[number];
