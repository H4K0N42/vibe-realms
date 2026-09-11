// Room manager: owns live rooms, routes protocol messages, and decides what each
// connection is allowed to see. Transport-agnostic: it talks to a `Connection`
// interface, so the tests drive it without opening a socket.
import { randomInt, randomUUID } from 'node:crypto';

import {
  MAX_PLAYERS,
  type ClientMessage,
  type ExpansionConfig,
  type RoomSettings,
  type ServerMessage,
} from '@fr/shared';

import { createEngine, scoreAll, shuffle, type RoomEngineHandle } from './engine.ts';
import type { Store } from './db.ts';
import {
  addPlayer, advanceReveal, beginReveal, createRoom, discard, draw, GameError,
  isRevealComplete, nextRevealCard, pendingActionsFor, publicState, pushRevealStep,
  removePlayer, reorderHand, resetToLobby, revealingPlayer, setActionChoice, setConnected,
  startGame, voteEndGame, type GameState,
} from './game.ts';

export interface Connection {
  id: string;
  send(message: ServerMessage): void;
  roomCode: string | null;
  playerId: string | null;
}

interface LiveRoom {
  state: GameState;
  /** Built lazily at game start: it needs the final player count. */
  engine: RoomEngineHandle | null;
}

// No 0/O/1/I/L: these get read aloud across a table.
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const CODE_LENGTH = 4;

/**
 * Give up looking for a free code rather than spinning. The loop below used to
 * be unbounded, which is fine while codes are plentiful and a hang once they
 * are not: 31^4 is 923,521, room creation is unauthenticated, and an abandoned
 * room sits in memory for about an hour before the sweeper takes it. Filling
 * the space froze the event loop for everybody, and because rooms are reloaded
 * from SQLite at boot, a restart came straight back up frozen.
 */
const MAX_CODE_ATTEMPTS = 200;

/**
 * Hard ceiling on live rooms. Well above any real table count and far below
 * the code space, so MAX_CODE_ATTEMPTS is never the thing that trips first.
 */
const MAX_ROOMS = 10_000;

/**
 * Uniform [0,1) from the CSPRNG, the default for both the room code and the
 * shuffle.
 *
 * Math.random is V8's xorshift128+, whose internal state is recoverable from a
 * handful of outputs. Both the code and the deck order came from that one
 * stream, so codes observed from the lobby were enough to predict the shuffle
 * of every game that followed. That was academic while the deployment sat
 * behind SSO; it is not academic for a server anyone can reach.
 */
function cryptoRandom(): number {
  return randomInt(2 ** 47) / 2 ** 47;
}

const DEFAULT_EXPANSIONS: ExpansionConfig = {
  cursedHoardSuits: false,
  cursedHoardItems: false,
};

export const DEFAULT_SETTINGS: RoomSettings = {
  expansions: DEFAULT_EXPANSIONS,
  locale: 'de',
};

export interface ManagerOptions {
  now?: () => number;
  rand?: () => number;
  makeEngine?: typeof createEngine;
}

export class RoomManager {
  #store: Store;
  #rooms = new Map<string, LiveRoom>();
  #connections = new Map<string, Set<Connection>>();
  #now: () => number;
  #rand: () => number;
  #makeEngine: typeof createEngine;

  constructor(store: Store, opts: ManagerOptions = {}) {
    this.#store = store;
    this.#now = opts.now ?? Date.now;
    this.#rand = opts.rand ?? cryptoRandom;
    this.#makeEngine = opts.makeEngine ?? createEngine;

    // Games in progress survive a restart. Everyone starts disconnected; they
    // come back with their resume token.
    for (const state of store.loadAll()) {
      for (const p of state.players) {
        p.connected = false;
        if (p.disconnectedSince === null) p.disconnectedSince = this.#now();
      }
      this.#rooms.set(state.code, { state, engine: null });
    }
  }

  get roomCount(): number {
    return this.#rooms.size;
  }

  createRoom(settings: Partial<RoomSettings> = {}): string {
    if (this.#rooms.size >= MAX_ROOMS) {
      throw new GameError('ROOM_FULL', 'the server is at its room limit');
    }
    let code = '';
    let attempts = 0;
    do {
      if (++attempts > MAX_CODE_ATTEMPTS) {
        throw new GameError('ROOM_FULL', 'no free room code available');
      }
      code = Array.from({ length: CODE_LENGTH }, () =>
        CODE_ALPHABET[Math.floor(this.#rand() * CODE_ALPHABET.length)],
      ).join('');
    } while (this.#rooms.has(code));

    const state = createRoom(code, { ...DEFAULT_SETTINGS, ...settings }, this.#now());
    this.#rooms.set(code, { state, engine: null });
    this.#store.save(state);
    return code;
  }

  handle(conn: Connection, message: ClientMessage): void {
    try {
      this.#dispatch(conn, message);
    } catch (err) {
      if (err instanceof GameError) {
        conn.send({ t: 'error', code: err.code as never, message: err.message });
        return;
      }
      throw err;
    }
  }

  #dispatch(conn: Connection, message: ClientMessage): void {
    if (message.t === 'join') return this.#join(conn, message);

    const room = this.#requireRoom(conn);
    const now = this.#now();
    const playerId = conn.playerId;
    if (!playerId) throw new GameError('ILLEGAL_MOVE', 'not joined');

    switch (message.t) {
      case 'leave':
        removePlayer(room.state, playerId, now);
        this.#detachConnection(conn);
        break;
      case 'updateSettings':
        if (room.state.phase !== 'lobby') throw new GameError('GAME_ALREADY_STARTED');
        room.state.settings = { ...room.state.settings, ...message.settings };
        break;
      case 'start': {
        const engine = this.#makeEngine(room.state.settings.expansions, room.state.players.length);
        room.engine = engine;
        const items = room.state.settings.expansions.cursedHoardItems
          ? shuffle(engine.cursedItemDeck(), this.#rand)
          : [];
        startGame(room.state, shuffle(engine.drawDeck(), this.#rand), 7, now, items);
        break;
      }
      case 'draw':
        draw(room.state, playerId, message.from, message.cardId, now, message.index);
        break;
      case 'discard':
        discard(room.state, playerId, message.cardId, now);
        break;
      case 'reorderHand':
        reorderHand(room.state, playerId, message.cards, now);
        break;
      case 'revealNext':
        this.#revealNext(room, playerId, now);
        break;
      case 'revealFinish':
        this.#revealFinish(room, playerId, now);
        break;
      case 'voteEndGame':
        voteEndGame(room.state, playerId, message.vote, now);
        break;
      case 'rematch':
        resetToLobby(room.state, now);
        break;
      case 'resolveAction':
        // Island, Book of Changes, Doppelganger and friends ask their holder a
        // question. Book of Changes needs two answers (target card, then suit),
        // so the choice is always a list.
        setActionChoice(
          room.state,
          playerId,
          message.cardId,
          message.choice ?? [],
          now,
        );
        // Re-score straight away so the running total reacts to the choice:
        // picking a Doppelganger target is the last big swing of the game and
        // the player should see it land, not read it off the final table.
        if (room.state.reveal && isRevealComplete(room.state)) {
          const scored = scoreAll(room.state, this.#engineFor(room))
            .find((sc) => sc.playerId === playerId);
          if (scored) room.state.reveal.finalTotal = scored.total;
        }
        break;
    }

    if (room.state.phase === 'scoring') beginReveal(room.state);
    this.#store.save(room.state);
    this.#broadcast(room);
  }

  /**
   * Whoever is being revealed drives their own reveal. If they have dropped,
   * anyone still connected may advance it; otherwise one closed laptop would
   * freeze the scoring for the whole table.
   */
  #mayDriveReveal(room: LiveRoom, playerId: string): boolean {
    const current = revealingPlayer(room.state);
    if (!current) return false;
    if (current.id === playerId) return true;
    return !current.connected;
  }

  #revealNext(room: LiveRoom, playerId: string, now: number): void {
    if (room.state.phase !== 'scoring') throw new GameError('ILLEGAL_MOVE', 'not scoring');
    if (!this.#mayDriveReveal(room, playerId)) {
      throw new GameError('ILLEGAL_MOVE', 'not your reveal');
    }
    const card = nextRevealCard(room.state);
    if (card === undefined) return; // already fully open

    const player = revealingPlayer(room.state)!;
    const engine = this.#engineFor(room);
    // Score the prefix that is face up. Fantasy Realms scoring is not additive:
    // a card can blank or rescue earlier ones, so each step is a fresh
    // scoring of everything revealed so far, and the client animates the diff.
    const faceUp = player.hand.slice(0, room.state.reveal!.steps.length + 1);
    const { total, breakdown } = engine.scoreHand(faceUp, room.state.discard, {});
    pushRevealStep(room.state, { cardId: card, total, breakdown }, now);
  }

  #revealFinish(room: LiveRoom, playerId: string, now: number): void {
    if (room.state.phase !== 'scoring') throw new GameError('ILLEGAL_MOVE', 'not scoring');
    if (!this.#mayDriveReveal(room, playerId)) {
      throw new GameError('ILLEGAL_MOVE', 'not your reveal');
    }
    if (!isRevealComplete(room.state)) {
      throw new GameError('ILLEGAL_MOVE', 'not every card is face up yet');
    }
    const player = revealingPlayer(room.state)!;
    const engine = this.#engineFor(room);
    // Only block on a player who is actually there to answer.
    if (player.connected && pendingActionsFor(room.state, player, engine.actionCardIds()).length > 0) {
      throw new GameError('ILLEGAL_MOVE', 'answer your action cards first');
    }

    const score = scoreAll(room.state, engine).find((s) => s.playerId === player.id)!;
    const done = advanceReveal(room.state, score, now);
    this.#store.save(room.state);
    this.#broadcast(room);
    if (done) this.#finish(room);
  }

  #engineFor(room: LiveRoom): RoomEngineHandle {
    return (room.engine ??= this.#makeEngine(
      room.state.settings.expansions,
      Math.max(2, room.state.players.length),
    ));
  }

  #join(conn: Connection, message: Extract<ClientMessage, { t: 'join' }>): void {
    const code = message.roomCode.trim().toUpperCase();
    const room = this.#rooms.get(code);
    if (!room) throw new GameError('ROOM_NOT_FOUND');
    const now = this.#now();

    let playerId: string;
    let token = message.resumeToken;
    const resumed = token ? this.#store.resolveToken(token) : null;

    if (resumed && resumed.code === code && room.state.players.some((p) => p.id === resumed.playerId)) {
      playerId = resumed.playerId;
      setConnected(room.state, playerId, true, now);
    } else {
      if (room.state.players.length >= MAX_PLAYERS) throw new GameError('ROOM_FULL');
      playerId = randomUUID();
      token = randomUUID();
      addPlayer(room.state, playerId, message.nickname, now);
      this.#store.putToken(token, code, playerId);
    }

    conn.roomCode = code;
    conn.playerId = playerId;
    let set = this.#connections.get(code);
    if (!set) this.#connections.set(code, (set = new Set()));
    set.add(conn);

    conn.send({ t: 'joined', playerId, resumeToken: token!, roomCode: code });
    this.#store.save(room.state);
    this.#broadcast(room);
  }

  /** A socket dropped. The seat is kept; the hand is still scored. */
  disconnect(conn: Connection): void {
    const room = conn.roomCode ? this.#rooms.get(conn.roomCode) : undefined;
    this.#detachConnection(conn);
    if (!room || !conn.playerId) return;
    setConnected(room.state, conn.playerId, false, this.#now());
    this.#store.save(room.state);
    this.#broadcast(room);
  }

  #detachConnection(conn: Connection): void {
    if (!conn.roomCode) return;
    this.#connections.get(conn.roomCode)?.delete(conn);
  }

  #requireRoom(conn: Connection): LiveRoom {
    const room = conn.roomCode ? this.#rooms.get(conn.roomCode) : undefined;
    if (!room) throw new GameError('ROOM_NOT_FOUND');
    return room;
  }

  /**
   * Public state to everyone, private hand to its owner only. A player's cards
   * never travel in the broadcast payload.
   */
  #broadcast(room: LiveRoom): void {
    const now = this.#now();
    const actionIds = room.engine ? room.engine.actionCardIds() : new Set<string>();
    const pub = publicState(room.state, now, actionIds);
    for (const conn of this.#connections.get(room.state.code) ?? []) {
      conn.send({ t: 'state', state: pub, settings: room.state.settings });
      const player = room.state.players.find((p) => p.id === conn.playerId);
      if (player) {
        conn.send({ t: 'hand', cards: [...player.hand], blanked: this.#blankedIn(room, player) });
      }
    }
  }

  /**
   * Which of a player's own cards are dead right now. Cheap (one scoring) and
   * private: it only ever goes to the player holding them.
   *
   * blankedIn(), not scoreHand(): between drawing and discarding the hand is
   * eight cards, which scoreHand rejects, and the hint used to disappear for
   * the whole of the turn where it decides the discard.
   *
   * #engineFor(), not room.engine: a room restored from the store after a
   * restart has no engine until something asks for one, and reading the field
   * directly meant the hint stayed dark for everyone until the next draw or
   * discard built it. The empty-hand check comes first so a room sitting in the
   * lobby still never spins up a vm context.
   */
  #blankedIn(room: LiveRoom, player: { hand: string[]; cursedItems: string[] }): string[] {
    if (player.hand.length === 0) return [];
    try {
      return this.#engineFor(room).blankedIn(
        [...player.hand, ...player.cursedItems],
        room.state.discard,
        {},
      );
    } catch {
      // A hand the engine will not score yet is simply not annotated.
      return [];
    }
  }

  #finish(room: LiveRoom): void {
    const engine = this.#engineFor(room);
    // Scores were locked in one at a time as each reveal finished.
    const scores = room.state.finalScores.length > 0
      ? room.state.finalScores
      : scoreAll(room.state, engine);
    const reason = room.state.endReason ?? 'discardPile';
    room.state.phase = 'finished';
    this.#store.save(room.state);
    for (const conn of this.#connections.get(room.state.code) ?? []) {
      conn.send({ t: 'scores', scores, reason });
    }
    engine.dispose();
    room.engine = null;
  }

  sweep(): void {
    const { deleted } = this.#store.sweep(this.#now());
    for (const code of deleted) {
      this.#rooms.get(code)?.engine?.dispose();
      this.#rooms.delete(code);
      this.#connections.delete(code);
    }
  }

  disposeAll(): void {
    for (const room of this.#rooms.values()) room.engine?.dispose();
  }
}
