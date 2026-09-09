import type { CardId } from './cards.js';

export interface ExpansionConfig {
  /** Cursed Hoard suits: Building / Outsider / Undead. Replaces 8 base cards. */
  cursedHoardSuits: boolean;
  /** Cursed Hoard items, drafted separately. */
  cursedHoardItems: boolean;
}

export interface RoomSettings {
  expansions: ExpansionConfig;
  locale: string;
}

export type PlayerId = string;

export interface PublicPlayer {
  id: PlayerId;
  nickname: string;
  connected: boolean;
  /** Server time (epoch ms) the player dropped, or null if connected. */
  disconnectedSince: number | null;
  /** Cards held. Count only; contents are private until scoring. */
  handCount: number;
  hasVotedToEnd: boolean;
}

export type Phase = 'lobby' | 'playing' | 'scoring' | 'finished';

/** One card turned face up during the end-of-game reveal. */
export interface RevealStep {
  cardId: CardId;
  /** Running total of everything face up so far. */
  total: number;
  /** State of every face-up card after this one joined them. */
  breakdown: PlayerScore['breakdown'];
}

/**
 * The reveal runs one player at a time, in seat order; everyone watches the
 * same card. Cards are turned in the order that player arranged them, so the
 * drag-and-drop ordering is what drives the presentation.
 */
export interface PublicReveal {
  playerId: PlayerId;
  playerIndex: number;
  playerCount: number;
  /** Cards face up so far, left to right. */
  steps: RevealStep[];
  handSize: number;
  /** Every card is face up; the action cards may now be answered. */
  complete: boolean;
  /** Action cards still awaiting an answer from the player being revealed. */
  pendingActions: CardId[];
  /** Set once choices are in and this player's score is final. */
  finalTotal: number | null;
}

export interface PublicGameState {
  phase: Phase;
  players: PublicPlayer[];
  /** Whose turn it is; null outside 'playing'. */
  turn: PlayerId | null;
  /** Face-up discard area, visible to everyone. */
  discard: CardId[];
  drawPileCount: number;
  /**
   * Set when at least one player has been disconnected past the grace period.
   * While non-null, connected players may vote to end the game early.
   * Unanimous among connected players.
   */
  endVote: { votes: PlayerId[]; needed: number } | null;
  /** Present during 'scoring': the card-by-card reveal everyone is watching. */
  reveal: PublicReveal | null;
}

/** Revealed only in 'scoring' / 'finished'. */
export interface PlayerScore {
  playerId: PlayerId;
  hand: CardId[];
  total: number;
  breakdown: Array<{
    cardId: CardId;
    base: number;
    bonus: number;
    penalty: number;
    blanked: boolean;
  }>;
}
