import type { CardId } from './cards.js';
import type { PlayerScore, PublicGameState, RoomSettings } from './game.js';

/** Client -> server. */
export type ClientMessage =
  | { t: 'join'; roomCode: string; nickname: string; resumeToken?: string }
  | { t: 'leave' }
  | { t: 'updateSettings'; settings: Partial<RoomSettings> }
  | { t: 'start' }
  /**
   * `index` is where in the hand the card was dropped. Omitted means the end,
   * which is what a click or the keyboard does. The hand's order is not
   * cosmetic (the reveal turns cards in exactly that order), so a card dragged
   * to a particular place belongs in that place.
   */
  | { t: 'draw'; from: 'deck' | 'discard'; cardId?: CardId; index?: number }
  | { t: 'discard'; cardId: CardId }
  /**
   * New hand order after drag-and-drop. The server keeps it because the
   * end-of-game reveal turns cards in exactly this order.
   */
  | { t: 'reorderHand'; cards: CardId[] }
  /** Turn the next card face up. Only the player being revealed may. */
  | { t: 'revealNext' }
  /** Choices are in; lock this player's score and move to the next. */
  | { t: 'revealFinish' }
  /**
   * Answer for a card that asks its holder a question at scoring time.
   * A list because Book of Changes takes two: the target card, then the suit
   * to change it to. Most cards take one. `null` declines to use the card.
   */
  | { t: 'resolveAction'; cardId: CardId; choice: string[] | null }
  | { t: 'voteEndGame'; vote: boolean }
  /**
   * Play again with the same people in the same room: back to the lobby with
   * everyone still seated, so nobody has to pass the code around twice.
   */
  | { t: 'rematch' };

/** Server -> client. */
export type ServerMessage =
  | { t: 'joined'; playerId: string; resumeToken: string; roomCode: string }
  | { t: 'state'; state: PublicGameState; settings: RoomSettings }
  /**
   * Your own hand. Never broadcast.
   * `blanked` is which of those cards are currently blanked by the rest of the
   * hand, shown permanently, so you can see a dead card without waiting for
   * the scoring. Private, like the hand itself.
   */
  | { t: 'hand'; cards: CardId[]; blanked: CardId[] }
  | { t: 'scores'; scores: PlayerScore[]; reason: 'discardPile' | 'earlyVote' }
  | { t: 'error'; code: ErrorCode; message: string };

export type ErrorCode =
  | 'ROOM_NOT_FOUND'
  | 'ROOM_FULL'
  | 'NAME_TAKEN'
  | 'NOT_YOUR_TURN'
  | 'ILLEGAL_MOVE'
  | 'GAME_ALREADY_STARTED'
  | 'NOT_ENOUGH_PLAYERS';

/** Cards in the discard area that end the game. */
export const DISCARD_LIMIT = 10;
export const MIN_PLAYERS = 2;
export const MAX_PLAYERS = 6;
/** Disconnect grace before the "vote to end early" button appears. */
export const DISCONNECT_GRACE_MS = 60_000;
/** No action from anyone for this long -> room marked abandoned. */
export const ROOM_IDLE_MS = 2 * 60 * 60 * 1000;
/** Abandoned rooms are deleted this long afterwards. */
export const ROOM_DELETE_AFTER_MS = 60 * 60 * 1000;
