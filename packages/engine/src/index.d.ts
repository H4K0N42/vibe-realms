/**
 * @fr/engine: a per-room `node:vm` wrapper around the vendored Fantasy Realms
 * scoring engine (`vendor/`, byte-for-byte upstream, never edited).
 *
 * The types below are deliberately standalone: this package has zero runtime
 * and zero build-time dependencies, so it cannot import from `@fr/shared`.
 * `ScoreResult` is structurally assignable to `Pick<PlayerScore, 'total' | 'breakdown'>`
 * from `packages/shared/src/game.ts`; `EngineCardDef` is a superset of `CardDef`
 * from `packages/shared/src/cards.ts`.
 */

/** e.g. 'FR01', 'FR55P', 'CH20'. */
export type CardId = string;

export type Suit =
  | 'land' | 'flood' | 'weather' | 'flame' | 'army' | 'wizard' | 'leader'
  | 'beast' | 'weapon' | 'artifact' | 'wild'
  | 'building' | 'outsider' | 'undead' | 'cursed-item';

/** Serializable card data lifted out of the vendored deck.js. */
export interface EngineCardDef {
  id: CardId;
  /** Upstream English name. Display text comes from i18n, not from here. */
  name: string;
  suit: Suit;
  strength: number;
  /** Needs a player choice when scoring (Island, Book of Changes, Doppelgänger...). */
  action: boolean;
  /** A Cursed Item: drafted separately and held face down. */
  cursedItem: boolean;
  /** Raises this room's hand limit by one while held. */
  extraCard: boolean;
  hasBonus: boolean;
  hasPenalty: boolean;
  /** Scores differently depending on the number of players. */
  referencesPlayerCount: boolean;
  /** Scores against the face-up discard area. */
  referencesDiscardArea: boolean;
  relatedSuits: string[];
  relatedCards: string[];
  /** Base card this Cursed Hoard card replaces, if any. */
  replaces?: CardId;
  /** Cursed Item play timing, e.g. 'any-time' / 'replace-turn'. */
  timing?: string;
}

export interface ScoreBreakdownEntry {
  cardId: CardId;
  /**
   * Effective strength. Doppelgänger / Shapeshifter / Mirage copy another card,
   * so this can differ from the printed value. A blanked card keeps its printed
   * strength here but contributes 0. See `points`.
   */
  base: number;
  bonus: number;
  penalty: number;
  blanked: boolean;
  /** Actual contribution to `total`: 0 if blanked, else base + bonus + penalty. */
  points: number;
  /** Effective name after actions resolve (Doppelgänger shows what it copied). */
  name: string;
  /** Effective suit after actions resolve (Book of Changes rewrites it). */
  suit: Suit;
}

export interface ScoreResult {
  total: number;
  breakdown: ScoreBreakdownEntry[];
  /** Upstream hand code, e.g. 'FR49,FR47+FR49:FR47:Wizard'. Useful in logs. */
  code: string;
}

export interface RoomEngineOptions {
  /** Cursed Hoard suits: Building / Outsider / Undead. Replaces 8 base cards. */
  cursedHoardSuits?: boolean;
  /** Cursed Hoard items, drafted separately and held face down. */
  cursedHoardItems?: boolean;
  /** Use the promo Phoenix (FR55P) instead of the base Phoenix (FR55). */
  phoenixPromo?: boolean;
  /** 2-6. Some cards score against it (CH06 Genie, CH24 Spyglass). */
  playerCount?: number;
}

export type RoomEngineSettings = Readonly<Required<RoomEngineOptions>>;

/**
 * One Fantasy Realms rules engine, isolated in its own `node:vm` context.
 *
 * One instance per room. The vendored engine keeps its state in process globals
 * (`hand`, `discard`, and a `deck` whose `.cards` is mutated in place by
 * `enableCursedHoardSuits()`), so sharing a context across rooms would let one
 * room's expansion settings corrupt another's deck mid-game.
 */
export class RoomEngine {
  constructor(opts?: RoomEngineOptions);

  readonly settings: RoomEngineSettings;
  readonly disposed: boolean;
  /** 7, or 8 with Cursed Hoard suits. Cards with `extraCard` add one more. */
  readonly handLimit: number;

  /**
   * Every card in play for this configuration. Base cards replaced by Cursed
   * Hoard are absent; exactly one of FR55 / FR55P is present.
   */
  listCards(): EngineCardDef[];
  getCard(id: CardId): EngineCardDef | undefined;

  /**
   * @param handCardIds     Cards held, including any face-down Cursed Items.
   * @param discardCardIds  Face-up discard area.
   * @param actionChoices   Choices for `action: true` cards, keyed by card id.
   *                        Book of Changes takes two: `{ FR49: ['FR47', 'Wizard'] }`.
   * @throws if an id is unknown to this room's deck, is duplicated, appears in
   *         both hand and discard, or if the hand exceeds the limit.
   */
  score(
    handCardIds: readonly (CardId | number)[],
    discardCardIds?: readonly (CardId | number)[],
    actionChoices?: Readonly<Record<CardId, CardId | string | readonly string[]>>,
  ): ScoreResult;

  /**
   * Which of these cards are blanked right now, ids in the order given.
   *
   * Unlike `score()` this accepts a hand over the limit, for the live hint
   * shown while a player holds eight cards between drawing and discarding.
   * Blanking alone; no totals.
   *
   * @throws on the same id problems as `score()`, but never on hand size.
   */
  blankedIn(
    handCardIds: readonly (CardId | number)[],
    discardCardIds?: readonly (CardId | number)[],
    actionChoices?: Readonly<Record<CardId, CardId | string | readonly string[]>>,
  ): CardId[];

  /** Drop the vm context. Every other member throws afterwards. */
  dispose(): void;
}

/** The 8 base cards Cursed Hoard's suit cards replace. */
export const CURSED_HOARD_REPLACES: readonly CardId[];
export const MIN_PLAYERS: 2;
export const MAX_PLAYERS: 6;
