// Runtime shape checks for everything a client sends.
//
// `JSON.parse(raw) as ClientMessage` in index.ts is an assertion, not a check:
// the type is erased before the bytes ever arrive. The game state machine
// already refuses illegal *moves* (wrong turn, card not held, a reorder that is
// not a permutation of the hand), and those checks are good. What nothing
// refused until now is absurd *sizes*, and size is the part that hurts a server
// rather than a game: a nickname is kept in the room state, rewritten to SQLite
// on every single save and broadcast to every player on every state change, so
// one 10 MB nickname is an amplifier with a long tail.
//
// Everything here is a bound, not a rule. Deciding whether a move is legal
// stays in game.ts, which is where it can be tested against the rules.
import type { ClientMessage, RoomSettings } from '@fr/shared';

export const LIMITS = {
  nickname: 24,
  roomCode: 8,
  resumeToken: 64,
  /** Card ids are `FR01`, `CH47`, `FR55P`. Deliberately not a format check:
   *  a regex tied to today's id scheme would turn a future card into a bug. */
  cardId: 8,
  /** A hand is 7, 8 with Cursed Hoard suits, 9 mid-turn with an item. */
  handCards: 16,
  /** Book of Changes takes two (target card, then suit); nothing takes more. */
  choiceArgs: 4,
  choiceArg: 32,
  locale: 16,
} as const;

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function str(v: unknown, max: number, { allowEmpty = false } = {}): boolean {
  return typeof v === 'string' && v.length <= max && (allowEmpty || v.trim().length > 0);
}

function optionalStr(v: unknown, max: number): boolean {
  return v === undefined || str(v, max);
}

function cardIds(v: unknown, max: number): boolean {
  return Array.isArray(v) && v.length <= max && v.every((c) => str(c, LIMITS.cardId));
}

function settings(v: unknown): boolean {
  if (!isObject(v)) return false;
  for (const [key, value] of Object.entries(v)) {
    if (key === 'locale') {
      if (!str(value, LIMITS.locale)) return false;
    } else if (key === 'expansions') {
      if (!isObject(value)) return false;
      if (Object.values(value).some((flag) => typeof flag !== 'boolean')) return false;
    } else {
      // Unknown keys are dropped rather than rejected: an older client that
      // still sends a retired setting should keep playing, it just does not get
      // to write free-form data into a row we persist.
      return false;
    }
  }
  return true;
}

/**
 * Same check for the settings body of `POST /api/rooms`, which reaches the
 * room state by a different door than the websocket and used to be merged in
 * unexamined.
 */
export function isSettingsPatch(value: unknown): value is Partial<RoomSettings> {
  return settings(value);
}

/**
 * True when `message` is shaped like the `ClientMessage` it claims to be.
 * Narrow enough for the caller to hand straight to the room manager.
 */
export function isClientMessage(message: unknown): message is ClientMessage {
  if (!isObject(message)) return false;
  switch (message.t) {
    case 'join':
      return (
        str(message.roomCode, LIMITS.roomCode) &&
        str(message.nickname, LIMITS.nickname) &&
        optionalStr(message.resumeToken, LIMITS.resumeToken)
      );
    case 'leave':
    case 'start':
    case 'revealNext':
    case 'revealFinish':
    case 'rematch':
      return true;
    case 'updateSettings':
      return settings(message.settings);
    case 'draw':
      return (
        (message.from === 'deck' || message.from === 'discard') &&
        optionalStr(message.cardId, LIMITS.cardId) &&
        (message.index === undefined ||
          (Number.isInteger(message.index) &&
            (message.index as number) >= 0 &&
            (message.index as number) <= LIMITS.handCards))
      );
    case 'discard':
      return str(message.cardId, LIMITS.cardId);
    case 'reorderHand':
      return cardIds(message.cards, LIMITS.handCards);
    case 'resolveAction':
      return (
        str(message.cardId, LIMITS.cardId) &&
        (message.choice === null ||
          (Array.isArray(message.choice) &&
            message.choice.length <= LIMITS.choiceArgs &&
            message.choice.every((c) => str(c, LIMITS.choiceArg, { allowEmpty: true }))))
      );
    case 'voteEndGame':
      return typeof message.vote === 'boolean';
    default:
      return false;
  }
}
