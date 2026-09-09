// Pure game state machine. No I/O, no websockets, no database, so it can be
// tested exhaustively and reasoned about on its own.
//
// The vendored engine contains NO game loop (it only scores hands and tracks a
// discard area), so turn order, drawing and the endgame triggers are all here.
import {
  DISCARD_LIMIT,
  type PlayerScore,
  type PublicReveal,
  type RevealStep,
  DISCONNECT_GRACE_MS,
  MAX_PLAYERS,
  MIN_PLAYERS,
  type CardId,
  type PlayerId,
  type Phase,
  type PublicGameState,
  type PublicPlayer,
  type RoomSettings,
} from '@fr/shared';

export interface PrivatePlayer {
  id: PlayerId;
  nickname: string;
  seat: number;
  connected: boolean;
  disconnectedSince: number | null;
  /** Private. Must never reach publicState(). */
  hand: CardId[];
  /**
   * Cursed Items sit in their own zone, not in the hand: the vendored engine
   * keeps them separate and they do not count against the hand limit.
   */
  cursedItems: CardId[];
  votedEnd: boolean;
  /** True once the player has drawn this turn and owes a discard. */
  drawnThisTurn: boolean;
}

export interface GameState {
  code: string;
  settings: RoomSettings;
  phase: Phase;
  players: PrivatePlayer[];
  turnIndex: number;
  /** Private: order must never leak. */
  drawPile: CardId[];
  discard: CardId[];
  createdAt: number;
  lastActionAt: number;
  endReason: 'discardPile' | 'earlyVote' | null;
  /** Card-by-card reveal, one player at a time. Set when scoring begins. */
  reveal: RevealState | null;
  /** Scores locked in as each player's reveal finishes. */
  finalScores: PlayerScore[];
  /**
   * Choices for cards that ask the player something at scoring time (Island,
   * Book of Changes, Doppelganger, Mirage, Shapeshifter, Angel). Collected in
   * the 'scoring' phase, keyed by player then by the card doing the asking.
   * Book of Changes takes two arguments (target card, then suit); the rest one.
   */
  actionChoices: Record<PlayerId, Record<CardId, string[]>>;
}

export class GameError extends Error {
  // Not a parameter property: node's strip-only TypeScript mode rejects those,
  // and the server runs .ts directly without a build step in dev.
  code: string;
  constructor(code: string, message?: string) {
    super(message ?? code);
    this.code = code;
  }
}

export function createRoom(code: string, settings: RoomSettings, now: number): GameState {
  return {
    code,
    settings,
    phase: 'lobby',
    players: [],
    turnIndex: 0,
    drawPile: [],
    discard: [],
    createdAt: now,
    lastActionAt: now,
    endReason: null,
    reveal: null,
    finalScores: [],
    actionChoices: {},
  };
}

export function addPlayer(
  state: GameState,
  id: PlayerId,
  nickname: string,
  now: number,
): PrivatePlayer {
  if (state.phase !== 'lobby') throw new GameError('GAME_ALREADY_STARTED');
  if (state.players.length >= MAX_PLAYERS) throw new GameError('ROOM_FULL');
  const trimmed = nickname.trim();
  if (!trimmed) throw new GameError('ILLEGAL_MOVE', 'nickname required');
  if (state.players.some((p) => p.nickname.toLowerCase() === trimmed.toLowerCase())) {
    throw new GameError('NAME_TAKEN');
  }
  const player: PrivatePlayer = {
    id,
    nickname: trimmed,
    seat: state.players.length,
    connected: true,
    disconnectedSince: null,
    hand: [],
    cursedItems: [],
    votedEnd: false,
    drawnThisTurn: false,
  };
  state.players.push(player);
  state.lastActionAt = now;
  return player;
}

export function removePlayer(state: GameState, id: PlayerId, now: number): void {
  // Only meaningful in the lobby; mid-game a leaver keeps their seat so the
  // hand can still be scored (DESIGN.md: disconnected players are still scored).
  if (state.phase !== 'lobby') {
    setConnected(state, id, false, now);
    return;
  }
  state.players = state.players.filter((p) => p.id !== id);
  state.players.forEach((p, i) => (p.seat = i));
  if (state.turnIndex >= state.players.length) state.turnIndex = 0;
  state.lastActionAt = now;
}

export function setConnected(
  state: GameState,
  id: PlayerId,
  connected: boolean,
  now: number,
): void {
  const player = state.players.find((p) => p.id === id);
  if (!player) return;
  player.connected = connected;
  player.disconnectedSince = connected ? null : now;
  // A reconnect makes the early-end vote moot: clear every cast vote so the
  // remaining players have to decide again with everyone present.
  if (connected) clearEndVotes(state);
}

function clearEndVotes(state: GameState): void {
  for (const p of state.players) p.votedEnd = false;
}

/**
 * @param deal 7 cards each, then the rest is the draw pile. Caller supplies the
 *   already-shuffled deck so shuffling stays injectable for tests.
 */
export function startGame(
  state: GameState,
  shuffled: CardId[],
  handSize: number,
  now: number,
  cursedItems: CardId[] = [],
): void {
  if (state.phase !== 'lobby') throw new GameError('GAME_ALREADY_STARTED');
  if (state.players.length < MIN_PLAYERS) throw new GameError('NOT_ENOUGH_PLAYERS');

  const needed = state.players.length * handSize;
  if (shuffled.length < needed + 1) {
    throw new GameError('ILLEGAL_MOVE', 'deck too small for this many players');
  }
  const deck = [...shuffled];
  const items = [...cursedItems];
  for (const player of state.players) {
    player.hand = deck.splice(0, handSize);
    // One Cursed Item each when the expansion is on, dealt from its own deck.
    player.cursedItems = items.length > 0 ? items.splice(0, 1) : [];
    player.drawnThisTurn = false;
    player.votedEnd = false;
  }
  state.drawPile = deck;
  state.discard = [];
  state.turnIndex = 0;
  state.phase = 'playing';
  state.endReason = null;
  state.reveal = null;
  state.finalScores = [];
  state.actionChoices = {};
  state.lastActionAt = now;
}

/**
 * Play again with the same people: back to the lobby with every seat kept.
 * Only from a finished game: there is nothing to reset before that, and
 * mid-game it would be a way to wipe everyone's hand.
 */
export function resetToLobby(state: GameState, now: number): void {
  if (state.phase !== 'finished') throw new GameError('ILLEGAL_MOVE', 'game is not over');
  // Whoever closed the tab after the final scores is not playing the next game.
  // Keeping their seat would deal them a hand and then stall on their turn
  // until the disconnect vote opened; they can rejoin from the lobby instead.
  state.players = state.players.filter((p) => p.connected);
  state.players.forEach((p, i) => (p.seat = i));
  for (const player of state.players) {
    player.hand = [];
    player.cursedItems = [];
    player.drawnThisTurn = false;
    player.votedEnd = false;
  }
  state.phase = 'lobby';
  state.turnIndex = 0;
  state.drawPile = [];
  state.discard = [];
  state.endReason = null;
  state.reveal = null;
  state.finalScores = [];
  state.actionChoices = {};
  state.lastActionAt = now;
}

export function currentPlayer(state: GameState): PrivatePlayer | undefined {
  return state.players[state.turnIndex];
}

function requireTurn(state: GameState, id: PlayerId): PrivatePlayer {
  if (state.phase !== 'playing') throw new GameError('ILLEGAL_MOVE', 'game is not in play');
  const player = currentPlayer(state);
  if (!player || player.id !== id) throw new GameError('NOT_YOUR_TURN');
  return player;
}

/** Draw from the deck, or take any one face-up card from the discard area. */
export function draw(
  state: GameState,
  id: PlayerId,
  from: 'deck' | 'discard',
  cardId: CardId | undefined,
  now: number,
): CardId {
  const player = requireTurn(state, id);
  if (player.drawnThisTurn) throw new GameError('ILLEGAL_MOVE', 'already drew this turn');

  let drawn: CardId;
  if (from === 'deck') {
    const next = state.drawPile.shift();
    if (next === undefined) throw new GameError('ILLEGAL_MOVE', 'draw pile is empty');
    drawn = next;
  } else {
    if (!cardId) throw new GameError('ILLEGAL_MOVE', 'cardId required when drawing from the discard area');
    const idx = state.discard.indexOf(cardId);
    if (idx === -1) throw new GameError('ILLEGAL_MOVE', 'card is not in the discard area');
    drawn = state.discard.splice(idx, 1)[0]!;
  }
  player.hand.push(drawn);
  player.drawnThisTurn = true;
  state.lastActionAt = now;
  return drawn;
}

export function discard(state: GameState, id: PlayerId, cardId: CardId, now: number): void {
  const player = requireTurn(state, id);
  if (!player.drawnThisTurn) throw new GameError('ILLEGAL_MOVE', 'draw before discarding');
  const idx = player.hand.indexOf(cardId);
  if (idx === -1) throw new GameError('ILLEGAL_MOVE', 'card is not in your hand');

  player.hand.splice(idx, 1);
  state.discard.push(cardId);
  player.drawnThisTurn = false;
  state.lastActionAt = now;

  if (state.discard.length >= DISCARD_LIMIT) {
    state.phase = 'scoring';
    state.endReason = 'discardPile';
    return;
  }
  advanceTurn(state);
}

function advanceTurn(state: GameState): void {
  if (state.players.length === 0) return;
  state.turnIndex = (state.turnIndex + 1) % state.players.length;
}

// --- early end vote ---------------------------------------------------------

/** Someone has been gone long enough that the button should appear. */
export function endVoteAvailable(state: GameState, now: number): boolean {
  return (
    state.phase === 'playing' &&
    state.players.some(
      (p) => !p.connected && p.disconnectedSince !== null && now - p.disconnectedSince >= DISCONNECT_GRACE_MS,
    )
  );
}

export function connectedPlayers(state: GameState): PrivatePlayer[] {
  return state.players.filter((p) => p.connected);
}

/**
 * Unanimous among currently connected players. With 2 players that means the one
 * remaining player ends it alone, which is correct: there is no game left.
 */
export function voteEndGame(state: GameState, id: PlayerId, vote: boolean, now: number): boolean {
  if (!endVoteAvailable(state, now)) throw new GameError('ILLEGAL_MOVE', 'no early-end vote is open');
  const player = state.players.find((p) => p.id === id);
  if (!player) throw new GameError('ILLEGAL_MOVE', 'unknown player');
  if (!player.connected) throw new GameError('ILLEGAL_MOVE', 'disconnected players cannot vote');

  player.votedEnd = vote;
  state.lastActionAt = now;

  const connected = connectedPlayers(state);
  if (connected.length > 0 && connected.every((p) => p.votedEnd)) {
    state.phase = 'scoring';
    state.endReason = 'earlyVote';
    return true;
  }
  return false;
}

// --- hand order ------------------------------------------------------------

/**
 * Reorder a hand after drag-and-drop. The order matters: the end-of-game reveal
 * turns cards face up left to right exactly as the player arranged them, so
 * this is a presentation decision the player gets to make.
 */
export function reorderHand(
  state: GameState,
  id: PlayerId,
  cards: CardId[],
  now: number,
): void {
  const player = state.players.find((p) => p.id === id);
  if (!player) throw new GameError('ILLEGAL_MOVE', 'unknown player');
  // Must be a permutation of the hand, never a way to gain, drop or swap cards.
  const before = [...player.hand].sort();
  const after = [...cards].sort();
  if (before.length !== after.length || before.some((c, i) => c !== after[i])) {
    throw new GameError('ILLEGAL_MOVE', 'reordered hand does not match the cards held');
  }
  player.hand = [...cards];
  state.lastActionAt = now;
}

// --- end-of-game reveal ----------------------------------------------------

export interface RevealState {
  /** Seat order: who is revealed after whom. */
  order: PlayerId[];
  playerIndex: number;
  steps: RevealStep[];
  finalTotal: number | null;
}

export function beginReveal(state: GameState): void {
  if (state.reveal) return;
  state.reveal = {
    order: [...state.players].sort((a, b) => a.seat - b.seat).map((p) => p.id),
    playerIndex: 0,
    steps: [],
    finalTotal: null,
  };
}

export function revealingPlayer(state: GameState): PrivatePlayer | undefined {
  const reveal = state.reveal;
  if (!reveal) return undefined;
  const id = reveal.order[reveal.playerIndex];
  return state.players.find((p) => p.id === id);
}

/** The next card to turn face up, or undefined when the hand is fully open. */
export function nextRevealCard(state: GameState): CardId | undefined {
  const player = revealingPlayer(state);
  if (!player || !state.reveal) return undefined;
  return player.hand[state.reveal.steps.length];
}

export function pushRevealStep(state: GameState, step: RevealStep, now: number): void {
  if (!state.reveal) throw new GameError('ILLEGAL_MOVE', 'no reveal in progress');
  state.reveal.steps.push(step);
  state.lastActionAt = now;
}

export function isRevealComplete(state: GameState): boolean {
  const player = revealingPlayer(state);
  return !!player && !!state.reveal && state.reveal.steps.length >= player.hand.length;
}

/**
 * Lock in this player's score and move to the next. Returns true when everyone
 * has been revealed and the game is over.
 */
export function advanceReveal(state: GameState, score: PlayerScore, now: number): boolean {
  const reveal = state.reveal;
  if (!reveal) throw new GameError('ILLEGAL_MOVE', 'no reveal in progress');
  state.finalScores.push(score);
  reveal.playerIndex += 1;
  reveal.steps = [];
  reveal.finalTotal = null;
  state.lastActionAt = now;

  if (reveal.playerIndex >= reveal.order.length) {
    state.phase = 'finished';
    state.reveal = null;
    return true;
  }
  return false;
}

/** Action cards the player being revealed has not answered yet. */
export function pendingActionsFor(
  state: GameState,
  player: PrivatePlayer,
  actionCardIds: Set<CardId>,
): CardId[] {
  const answered = state.actionChoices[player.id] ?? {};
  return player.hand.filter((c) => actionCardIds.has(c) && answered[c] === undefined);
}

export function publicReveal(
  state: GameState,
  actionCardIds: Set<CardId>,
): PublicReveal | null {
  const reveal = state.reveal;
  const player = revealingPlayer(state);
  if (!reveal || !player) return null;
  return {
    playerId: player.id,
    playerIndex: reveal.playerIndex,
    playerCount: reveal.order.length,
    steps: reveal.steps,
    handSize: player.hand.length,
    complete: reveal.steps.length >= player.hand.length,
    // Only once every card is face up: before that this would reveal which
    // action cards the player is holding.
    pendingActions: reveal.steps.length >= player.hand.length
      ? pendingActionsFor(state, player, actionCardIds)
      : [],
    finalTotal: reveal.finalTotal,
  };
}

// --- scoring-time action choices -------------------------------------------

/** Cards that ask their holder a question when the hand is scored. */
export function setActionChoice(
  state: GameState,
  playerId: PlayerId,
  cardId: CardId,
  choice: string[],
  now: number,
): void {
  if (state.phase !== 'scoring') throw new GameError('ILLEGAL_MOVE', 'not scoring yet');
  if (state.reveal && revealingPlayer(state)?.id !== playerId) {
    throw new GameError('ILLEGAL_MOVE', 'wait for your turn to be revealed');
  }
  const player = state.players.find((p) => p.id === playerId);
  if (!player) throw new GameError('ILLEGAL_MOVE', 'unknown player');
  if (!player.hand.includes(cardId)) throw new GameError('ILLEGAL_MOVE', 'card is not in your hand');
  state.actionChoices[playerId] ??= {};
  state.actionChoices[playerId]![cardId] = choice;
  state.lastActionAt = now;
}

/**
 * Players still owing a choice. A disconnected player cannot answer, so their
 * cards are scored with no choice rather than stalling everyone else.
 */
export function playersAwaitingChoices(state: GameState, actionCardIds: Set<CardId>): PlayerId[] {
  return state.players
    .filter((p) => p.connected)
    .filter((p) => {
      const answered = state.actionChoices[p.id] ?? {};
      return p.hand.some((c) => actionCardIds.has(c) && answered[c] === undefined);
    })
    .map((p) => p.id);
}

// --- views ------------------------------------------------------------------

/** Everything safe to broadcast. Hands and draw-pile order are excluded. */
export function publicState(
  state: GameState,
  now: number,
  actionCardIds: Set<CardId> = new Set(),
): PublicGameState {
  const players: PublicPlayer[] = state.players.map((p) => ({
    id: p.id,
    nickname: p.nickname,
    connected: p.connected,
    disconnectedSince: p.disconnectedSince,
    handCount: p.hand.length,
    hasVotedToEnd: p.votedEnd,
  }));

  const voteOpen = endVoteAvailable(state, now);
  return {
    phase: state.phase,
    players,
    turn: state.phase === 'playing' ? (currentPlayer(state)?.id ?? null) : null,
    discard: [...state.discard],
    drawPileCount: state.drawPile.length,
    endVote: voteOpen
      ? {
          votes: connectedPlayers(state).filter((p) => p.votedEnd).map((p) => p.id),
          needed: connectedPlayers(state).length,
        }
      : null,
    reveal: publicReveal(state, actionCardIds),
  };
}
