import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';

import { DISCONNECT_GRACE_MS, type ServerMessage } from '@fr/shared';

import { openStore, type Store } from '../src/db.ts';
import type { RoomEngineHandle } from '../src/engine.ts';
import { RoomManager, type Connection } from '../src/rooms.ts';

const DECK = Array.from({ length: 53 }, (_, i) => `FR${String(i + 1).padStart(2, '0')}`);

/** Stand-in for the vm engine: the real one is covered by @fr/engine's suite. */
function fakeEngine(): RoomEngineHandle {
  return {
    drawDeck: () => [...DECK],
    cursedItemDeck: () => [],
    handLimit: () => 7,
    actionCardIds: () => new Set<string>(),
    scoreHand: (hand) => ({
      total: hand.length * 10,
      breakdown: hand.map((cardId) => ({ cardId, base: 10, bonus: 0, penalty: 0, blanked: false })),
    }),
    // Nothing is ever blanked here, but it answers for eight cards as the real
    // one does, so the live hint keeps working mid-turn.
    blankedIn: () => [],
    dispose: () => {},
  };
}

class FakeConn implements Connection {
  id = Math.random().toString(36).slice(2);
  roomCode: string | null = null;
  playerId: string | null = null;
  received: ServerMessage[] = [];
  send(m: ServerMessage) { this.received.push(m); }
  last<T extends ServerMessage['t']>(t: T) {
    return [...this.received].reverse().find((m) => m.t === t) as Extract<ServerMessage, { t: T }> | undefined;
  }
}

let dir: string;
let store: Store;
let now = 1000;
let manager: RoomManager;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'fr-rooms-'));
  store = openStore(dir);
  now = 1000;
  manager = new RoomManager(store, {
    now: () => now,
    rand: () => 0.5,
    makeEngine: () => fakeEngine(),
  });
});
afterEach(() => {
  manager.disposeAll();
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

function seat(code: string, nickname: string): FakeConn {
  const c = new FakeConn();
  manager.handle(c, { t: 'join', roomCode: code, nickname });
  return c;
}


/**
 * Drive the end-of-game reveal to completion. Scoring is no longer immediate:
 * each player's hand is turned face up card by card, then their action cards
 * are answered, then the next player goes.
 *
 * @param live connections still connected (a dropped player's reveal is driven
 *   by anyone else, which is what the server allows).
 */
function driveReveal(m: RoomManager, live: FakeConn[]): void {
  for (let guard = 0; guard < 300; guard += 1) {
    const view = live[0]?.last('state')?.state;
    if (!view || view.phase !== 'scoring' || !view.reveal) return;
    const r = view.reveal;
    const owner = live.find((c) => c.playerId === r.playerId);
    const driver = owner ?? live[0]!;

    if (r.steps.length < r.handSize) {
      m.handle(driver, { t: 'revealNext' });
      continue;
    }
    if (owner && r.pendingActions.length > 0) {
      for (const cardId of r.pendingActions) {
        m.handle(owner, { t: 'resolveAction', cardId, choice: null });
      }
      continue;
    }
    m.handle(driver, { t: 'revealFinish' });
  }
  throw new Error('reveal did not finish');
}

describe('joining', () => {
  it('rejects an unknown room code', () => {
    const c = new FakeConn();
    manager.handle(c, { t: 'join', roomCode: 'ZZZZ', nickname: 'a' });
    assert.equal(c.last('error')?.code, 'ROOM_NOT_FOUND');
  });

  it('is case-insensitive about the room code', () => {
    const code = manager.createRoom();
    const c = new FakeConn();
    manager.handle(c, { t: 'join', roomCode: code.toLowerCase(), nickname: 'a' });
    assert.ok(c.last('joined'));
  });

  it('restores the same seat and hand from a resume token', () => {
    const code = manager.createRoom();
    const a = seat(code, 'a');
    seat(code, 'b');
    manager.handle(a, { t: 'start' });
    const handBefore = a.last('hand')?.cards;
    const token = a.last('joined')!.resumeToken;

    manager.disconnect(a);
    const back = new FakeConn();
    manager.handle(back, { t: 'join', roomCode: code, nickname: 'a', resumeToken: token });

    assert.equal(back.last('joined')?.playerId, a.last('joined')?.playerId);
    assert.deepEqual(back.last('hand')?.cards, handBefore);
    assert.equal(back.last('state')?.state.players.length, 2);
  });

  it('does not seat a 7th player', () => {
    const code = manager.createRoom();
    for (const n of ['a', 'b', 'c', 'd', 'e', 'f']) seat(code, n);
    const seventh = seat(code, 'g');
    assert.equal(seventh.last('error')?.code, 'ROOM_FULL');
  });
});

describe('hidden information over the wire', () => {
  it('never sends one player their opponent\'s cards', () => {
    const code = manager.createRoom();
    const a = seat(code, 'a');
    const b = seat(code, 'b');
    manager.handle(a, { t: 'start' });

    const bHand = new Set(b.last('hand')!.cards);
    // Everything A ever received, minus A's own private hand messages.
    const aPublic = a.received.filter((m) => m.t !== 'hand');
    const json = JSON.stringify(aPublic);
    for (const card of bHand) {
      assert.ok(!json.includes(card), `opponent card ${card} leaked to the other player`);
    }
  });

  it('does not leak the draw pile order', () => {
    const code = manager.createRoom();
    const a = seat(code, 'a');
    seat(code, 'b');
    manager.handle(a, { t: 'start' });
    const state = a.last('state')!.state;
    assert.equal(state.drawPileCount, DECK.length - 14);
    assert.ok(!('drawPile' in state));
  });
});

describe('turn enforcement over the wire', () => {
  it('refuses a move from the wrong player', () => {
    const code = manager.createRoom();
    const a = seat(code, 'a');
    const b = seat(code, 'b');
    manager.handle(a, { t: 'start' });
    manager.handle(b, { t: 'draw', from: 'deck' });
    assert.equal(b.last('error')?.code, 'NOT_YOUR_TURN');
  });

  it('still reports blanked cards while the hand is eight', () => {
    // The live hint used to come from scoreHand, which refuses an over-full
    // hand, so it went empty for the whole of the turn between drawing and
    // discarding: exactly when it is deciding what to throw away.
    // The fake's scoreHand never blanks anything and its blankedIn always
    // blanks the first card, so this can only pass by way of blankedIn.
    const m = new RoomManager(store, {
      now: () => now,
      rand: () => 0.5,
      makeEngine: () => ({ ...fakeEngine(), blankedIn: (hand) => [hand[0]!] }),
    });
    const code = m.createRoom();
    const a = new FakeConn();
    m.handle(a, { t: 'join', roomCode: code, nickname: 'a' });
    const b = new FakeConn();
    m.handle(b, { t: 'join', roomCode: code, nickname: 'b' });
    m.handle(a, { t: 'start' });

    assert.equal(a.last('hand')!.cards.length, 7);
    assert.deepEqual(a.last('hand')!.blanked, [a.last('hand')!.cards[0]]);

    m.handle(a, { t: 'draw', from: 'deck' });
    const eight = a.last('hand')!;
    assert.equal(eight.cards.length, 8);
    assert.deepEqual(eight.blanked, [eight.cards[0]], 'hint lost at eight cards');
    m.disposeAll();
  });

  it('reports blanked cards on the first broadcast after a restart', () => {
    // A room restored from the store has no engine yet. Reading room.engine
    // directly meant the hint stayed dark until the next draw or discard built
    // one, so a resumed game came back with nothing marked.
    const opts = {
      now: () => now,
      rand: () => 0.5,
      makeEngine: () => ({ ...fakeEngine(), blankedIn: (hand: string[]) => [hand[0]!] }),
    };
    const before = new RoomManager(store, opts);
    const code = before.createRoom();
    const a = new FakeConn();
    before.handle(a, { t: 'join', roomCode: code, nickname: 'a' });
    const b = new FakeConn();
    before.handle(b, { t: 'join', roomCode: code, nickname: 'b' });
    before.handle(a, { t: 'start' });
    const token = a.last('joined')!.resumeToken;
    before.disposeAll();

    // A second manager over the same store is what a restart looks like.
    const after = new RoomManager(store, opts);
    const back = new FakeConn();
    after.handle(back, { t: 'join', roomCode: code, nickname: 'a', resumeToken: token });

    const hand = back.last('hand')!;
    assert.equal(hand.cards.length, 7);
    assert.deepEqual(hand.blanked, [hand.cards[0]], 'hint dark until the first move');
    after.disposeAll();
  });

  it('lets the player whose turn it is draw and discard', () => {
    const code = manager.createRoom();
    const a = seat(code, 'a');
    const b = seat(code, 'b');
    manager.handle(a, { t: 'start' });
    manager.handle(a, { t: 'draw', from: 'deck' });
    const hand = a.last('hand')!.cards;
    assert.equal(hand.length, 8);
    manager.handle(a, { t: 'discard', cardId: hand[0]! });
    assert.equal(a.last('hand')?.cards.length, 7);
    assert.equal(a.last('state')?.state.turn, b.last('joined')?.playerId);
  });
});

describe('early end vote over the wire', () => {
  it('opens only after the grace period and ends on unanimity', () => {
    const code = manager.createRoom();
    const a = seat(code, 'a');
    const b = seat(code, 'b');
    const c = seat(code, 'c');
    manager.handle(a, { t: 'start' });

    manager.disconnect(c);
    assert.equal(a.last('state')?.state.endVote, null);

    now += DISCONNECT_GRACE_MS;
    manager.handle(a, { t: 'voteEndGame', vote: true });
    assert.equal(a.last('state')?.state.endVote?.needed, 2);
    assert.equal(a.last('scores'), undefined);

    manager.handle(b, { t: 'voteEndGame', vote: true });
    assert.equal(a.last('state')?.state.phase, 'scoring', 'the reveal begins');
    assert.ok(a.last('state')?.state.reveal, 'a reveal is in progress');

    driveReveal(manager, [a, b]);
    const scores = a.last('scores');
    assert.equal(scores?.reason, 'earlyVote');
    assert.equal(scores?.scores.length, 3, 'the disconnected player is still scored');
  });

  it('scores the best 7 when a player dropped mid-turn holding 8', () => {
    const code = manager.createRoom();
    const a = seat(code, 'a');
    const b = seat(code, 'b');
    manager.handle(a, { t: 'start' });
    manager.handle(a, { t: 'draw', from: 'deck' }); // a now holds 8
    manager.disconnect(a);

    now += DISCONNECT_GRACE_MS;
    manager.handle(b, { t: 'voteEndGame', vote: true });
    driveReveal(manager, [b]);

    const scores = b.last('scores')!.scores;
    const dropped = scores.find((s) => s.playerId === a.last('joined')!.playerId)!;
    assert.equal(dropped.hand.length, 7, 'scored a legal 7-card subset, not 8');
    assert.equal(dropped.total, 70);
  });
});

describe('restart recovery', () => {
  it('reloads games in progress with everyone marked disconnected', () => {
    const code = manager.createRoom();
    const a = seat(code, 'a');
    seat(code, 'b');
    manager.handle(a, { t: 'start' });
    const token = a.last('joined')!.resumeToken;

    const revived = new RoomManager(store, { now: () => now, rand: () => 0.5, makeEngine: () => fakeEngine() });
    const back = new FakeConn();
    revived.handle(back, { t: 'join', roomCode: code, nickname: 'a', resumeToken: token });
    assert.equal(back.last('state')?.state.phase, 'playing');
    assert.equal(back.last('hand')?.cards.length, 7);
    revived.disposeAll();
  });
});

describe('scoring-time action choices', () => {
  /**
   * The set of "asks a question" cards is decided after the deal, so the test
   * can point it at a card the player actually holds rather than assuming
   * anything about shuffle order.
   */
  function tableWithActionCard() {
    const actionIds = new Set<string>();
    const engine = (): RoomEngineHandle => ({
      ...fakeEngine(),
      actionCardIds: () => actionIds,
      scoreHand: (hand, _discard, choices = {}) => ({
        total: hand.length * 10 + (Object.keys(choices).length > 0 ? 100 : 0),
        breakdown: hand.map((cardId) => ({ cardId, base: 10, bonus: 0, penalty: 0, blanked: false })),
      }),
    });

    const m = new RoomManager(store, { now: () => now, rand: () => 0.5, makeEngine: engine });
    const code = m.createRoom();
    const a = new FakeConn();
    const b = new FakeConn();
    m.handle(a, { t: 'join', roomCode: code, nickname: 'a' });
    m.handle(b, { t: 'join', roomCode: code, nickname: 'b' });
    m.handle(a, { t: 'start' });
    const actionCard = a.last('hand')!.cards[0]!;
    actionIds.add(actionCard);
    return { m, a, b, actionCard };
  }

  it('waits for the choice instead of scoring immediately', () => {
    const { m, a, b, actionCard } = tableWithActionCard();
    m.disconnect(b);
    now += DISCONNECT_GRACE_MS;
    m.handle(a, { t: 'voteEndGame', vote: true });

    assert.equal(a.last('scores'), undefined, 'did not score while a choice is outstanding');

    // Turn every card face up, then the action card can be answered.
    const view = () => a.last('state')!.state.reveal!;
    while (view().steps.length < view().handSize) m.handle(a, { t: 'revealNext' });
    assert.deepEqual(view().pendingActions, [actionCard]);

    m.handle(a, { t: 'revealFinish' });
    assert.match(a.last('error')!.message, /answer your action cards/);

    m.handle(a, { t: 'resolveAction', cardId: actionCard, choice: ['FR02'] });
    driveReveal(m, [a]);
    const scores = a.last('scores');
    assert.ok(scores, 'scored once the choice arrived');
    const mine = scores!.scores.find((s) => s.playerId === a.playerId)!;
    assert.equal(mine.total, 170, 'the choice reached the engine');
    m.disposeAll();
  });

  it('does not wait on a disconnected player who cannot answer', () => {
    const { m, a, b } = tableWithActionCard();
    m.disconnect(a); // the holder of the action card leaves
    now += DISCONNECT_GRACE_MS;
    m.handle(b, { t: 'voteEndGame', vote: true });
    // b drives the absent player's reveal too.
    driveReveal(m, [b]);
    assert.ok(b.last('scores'), 'scored without stalling on the absent player');
    m.disposeAll();
  });

  it('refuses a choice for a card the player does not hold', () => {
    const { m, a, b } = tableWithActionCard();
    m.disconnect(b);
    now += DISCONNECT_GRACE_MS;
    m.handle(a, { t: 'voteEndGame', vote: true });
    m.handle(a, { t: 'resolveAction', cardId: 'CH99', choice: ['FR02'] });
    assert.match(a.last('error')!.message, /not in your hand/);
    m.disposeAll();
  });
});

describe('hand order and reveal', () => {
  function table() {
    const m = new RoomManager(store, { now: () => now, rand: () => 0.5, makeEngine: () => fakeEngine() });
    const code = m.createRoom();
    const a = new FakeConn();
    const b = new FakeConn();
    m.handle(a, { t: 'join', roomCode: code, nickname: 'a' });
    m.handle(b, { t: 'join', roomCode: code, nickname: 'b' });
    m.handle(a, { t: 'start' });
    return { m, a, b };
  }

  function endGame(m: RoomManager, a: FakeConn, b: FakeConn) {
    m.disconnect(b);
    now += DISCONNECT_GRACE_MS;
    m.handle(a, { t: 'voteEndGame', vote: true });
  }

  it('reorders a hand and reports the new order back', () => {
    const { m, a } = table();
    const hand = a.last('hand')!.cards;
    const shuffled = [...hand].reverse();
    m.handle(a, { t: 'reorderHand', cards: shuffled });
    assert.deepEqual(a.last('hand')!.cards, shuffled);
    m.disposeAll();
  });

  it('refuses a reorder that adds, drops or swaps a card', () => {
    const { m, a } = table();
    const hand = a.last('hand')!.cards;
    m.handle(a, { t: 'reorderHand', cards: hand.slice(1) });
    assert.match(a.last('error')!.message, /does not match/);
    m.handle(a, { t: 'reorderHand', cards: [...hand.slice(1), 'FR99'] });
    assert.match(a.last('error')!.message, /does not match/);
    assert.deepEqual(a.last('hand')!.cards, hand, 'hand untouched');
    m.disposeAll();
  });

  it('turns cards face up in the order the player arranged them', () => {
    const { m, a, b } = table();
    const wanted = [...a.last('hand')!.cards].reverse();
    m.handle(a, { t: 'reorderHand', cards: wanted });
    endGame(m, a, b);

    for (let i = 0; i < wanted.length; i++) {
      m.handle(a, { t: 'revealNext' });
      const steps = a.last('state')!.state.reveal!.steps;
      assert.equal(steps.length, i + 1);
      assert.equal(steps[i]!.cardId, wanted[i], `card ${i} follows the chosen order`);
    }
    m.disposeAll();
  });

  it('reports a running total that everyone can watch', () => {
    const { m, a, b } = table();
    endGame(m, a, b);
    const totals: number[] = [];
    for (let i = 0; i < 7; i++) {
      m.handle(a, { t: 'revealNext' });
      totals.push(a.last('state')!.state.reveal!.steps.at(-1)!.total);
    }
    // The fake engine scores 10 a card, so the running total climbs predictably.
    assert.deepEqual(totals, [10, 20, 30, 40, 50, 60, 70]);
    m.disposeAll();
  });

  it('does not reveal which action cards are held until the hand is open', () => {
    const { m, a, b } = table();
    endGame(m, a, b);
    m.handle(a, { t: 'revealNext' });
    assert.deepEqual(a.last('state')!.state.reveal!.pendingActions, [],
      'pending actions stay hidden mid-reveal');
    m.disposeAll();
  });

  it('lets only the player being revealed drive their own reveal', () => {
    const { m, a, b } = table();
    // Both connected, a is revealed first.
    now += 1;
    m.handle(a, { t: 'voteEndGame', vote: true });
    m.disconnect(b);
    now += DISCONNECT_GRACE_MS;
    m.handle(a, { t: 'voteEndGame', vote: true });

    const other = new FakeConn();
    m.handle(other, { t: 'join', roomCode: a.roomCode!, nickname: 'c' });
    m.handle(other, { t: 'revealNext' });
    assert.ok(other.last('error'), 'a bystander cannot drive someone else\'s reveal');
    m.disposeAll();
  });

  it('lets others drive the reveal of a player who has dropped', () => {
    const { m, a, b } = table();
    // b is revealed second; drop a so b must drive a's reveal.
    m.disconnect(a);
    now += DISCONNECT_GRACE_MS;
    m.handle(b, { t: 'voteEndGame', vote: true });

    const r = () => b.last('state')!.state.reveal!;
    assert.equal(r().playerId, a.playerId, 'the dropped player is revealed first');
    while (r().steps.length < r().handSize) m.handle(b, { t: 'revealNext' });
    m.handle(b, { t: 'revealFinish' });
    assert.equal(b.last('state')!.state.reveal!.playerId, b.playerId, 'moved on to b');
    m.disposeAll();
  });
});

describe('running total reacts to action choices', () => {
  it('updates the reveal total as soon as a choice is made', () => {
    const actionIds = new Set<string>();
    const engine = (): RoomEngineHandle => ({
      ...fakeEngine(),
      actionCardIds: () => actionIds,
      scoreHand: (hand, _d, choices = {}) => ({
        total: hand.length * 10 + (Object.keys(choices).length > 0 ? 100 : 0),
        breakdown: hand.map((cardId) => ({ cardId, base: 10, bonus: 0, penalty: 0, blanked: false })),
      }),
    });
    const m = new RoomManager(store, { now: () => now, rand: () => 0.5, makeEngine: engine });
    const code = m.createRoom();
    const a = new FakeConn();
    const b = new FakeConn();
    m.handle(a, { t: 'join', roomCode: code, nickname: 'a' });
    m.handle(b, { t: 'join', roomCode: code, nickname: 'b' });
    m.handle(a, { t: 'start' });
    const actionCard = a.last('hand')!.cards[0]!;
    actionIds.add(actionCard);

    m.disconnect(b);
    now += DISCONNECT_GRACE_MS;
    m.handle(a, { t: 'voteEndGame', vote: true });

    const r = () => a.last('state')!.state.reveal!;
    while (r().steps.length < r().handSize) m.handle(a, { t: 'revealNext' });
    assert.equal(r().finalTotal, null, 'no final total before any choice');
    assert.equal(r().steps.at(-1)!.total, 70);

    m.handle(a, { t: 'resolveAction', cardId: actionCard, choice: ['FR02'] });
    assert.equal(r().finalTotal, 170, 'the total reacts to the choice immediately');
    m.disposeAll();
  });
});

describe('blanked cards are reported live', () => {
  it('tells a player which of their own cards are dead, and nobody else', () => {
    // Fake engine: FR13 (Smoke) is blanked unless a Flame is present.
    const engine = (): RoomEngineHandle => ({
      ...fakeEngine(),
      scoreHand: (hand) => ({
        total: 0,
        breakdown: hand.map((cardId) => ({
          cardId, base: 10, bonus: 0, penalty: 0,
          blanked: cardId === 'FR13' && !hand.includes('FR16'),
        })),
      }),
    });
    const m = new RoomManager(store, { now: () => now, rand: () => 0.5, makeEngine: engine });
    const code = m.createRoom();
    const a = new FakeConn();
    const b = new FakeConn();
    m.handle(a, { t: 'join', roomCode: code, nickname: 'a' });
    m.handle(b, { t: 'join', roomCode: code, nickname: 'b' });
    m.handle(a, { t: 'start' });

    for (const conn of [a, b]) {
      const own = conn.last('hand')!;
      const expected = own.cards.includes('FR13') && !own.cards.includes('FR16') ? ['FR13'] : [];
      assert.deepEqual(own.blanked, expected, 'blanked matches this player\'s own hand');
    }
    // It rides on the private hand message, so it never reaches anyone else.
    const broadcast = JSON.stringify(a.received.filter((msg) => msg.t !== 'hand'));
    assert.ok(!broadcast.includes('blanked'));
    m.disposeAll();
  });
});

describe('rematch', () => {
  it('puts the same players back in the lobby with fresh hands', () => {
    const code = manager.createRoom();
    const a = seat(code, 'a');
    const b = seat(code, 'b');
    manager.handle(a, { t: 'start' });

    // Ten discards end the game.
    for (let i = 0; i < 10; i += 1) {
      const who = i % 2 === 0 ? a : b;
      manager.handle(who, { t: 'draw', from: 'deck' });
      manager.handle(who, { t: 'discard', cardId: who.last('hand')!.cards[0]! });
    }
    driveReveal(manager, [a, b]);
    assert.ok(a.last('scores'), 'the game finished');

    manager.handle(a, { t: 'rematch' });
    const state = b.last('state')!.state;
    assert.equal(state.phase, 'lobby');
    assert.equal(state.players.length, 2, 'everyone keeps their seat');
    assert.equal(state.discard.length, 0);
    assert.deepEqual(b.last('hand')!.cards, [], 'hands are cleared');

    // And the room is playable again.
    manager.handle(a, { t: 'start' });
    assert.equal(a.last('state')!.state.phase, 'playing');
    assert.equal(a.last('hand')!.cards.length, 7);
    assert.notEqual(a.last('state')!.state.drawPileCount, 0);
  });

  it('refuses a rematch while a game is still running', () => {
    const code = manager.createRoom();
    const a = seat(code, 'a');
    seat(code, 'b');
    manager.handle(a, { t: 'start' });

    manager.handle(a, { t: 'rematch' });
    assert.equal(a.last('error')?.code, 'ILLEGAL_MOVE');
    assert.equal(a.last('state')?.state.phase, 'playing', 'the game is untouched');
  });
});

describe('rematch drops players who have gone', () => {
  it('does not deal a hand to someone who left after the final scores', () => {
    const code = manager.createRoom();
    const a = seat(code, 'a');
    const b = seat(code, 'b');
    const c = seat(code, 'c');
    manager.handle(a, { t: 'start' });
    for (let i = 0; i < 10; i += 1) {
      const who = [a, b, c][i % 3]!;
      manager.handle(who, { t: 'draw', from: 'deck' });
      manager.handle(who, { t: 'discard', cardId: who.last('hand')!.cards[0]! });
    }
    driveReveal(manager, [a, b, c]);

    manager.disconnect(c); // closed the tab on the scoreboard
    manager.handle(a, { t: 'rematch' });

    const state = a.last('state')!.state;
    assert.equal(state.players.length, 2, 'the seat is not held for the next game');
    assert.ok(!state.players.some((p) => p.nickname === 'c'));

    // ...and the new game is playable rather than stalled on an empty seat.
    manager.handle(a, { t: 'start' });
    assert.equal(a.last('state')!.state.phase, 'playing');
    assert.equal(a.last('state')!.state.turn, a.playerId);
  });
});

describe('room code exhaustion', () => {
  // Regression: the code search used to be `do {...} while (taken)` with no way
  // out. A full code space meant an unbounded loop on the event loop thread,
  // which is a hang of the whole server rather than an error to one caller, and
  // rooms are reloaded from SQLite at boot so a restart did not clear it.
  // A fixed `rand` collapses the space to exactly one code, which is the same
  // situation arrived at cheaply. The timeout is the actual assertion: without
  // the bound this test never returns.
  it('gives up instead of spinning when no code is free', { timeout: 5000 }, () => {
    const m = new RoomManager(store, {
      now: () => now,
      rand: () => 0.5,
      makeEngine: () => fakeEngine(),
    });
    const first = m.createRoom();
    assert.equal(typeof first, 'string');
    assert.throws(() => m.createRoom(), /no free room code/);
    m.disposeAll();
  });

  it('keeps handing out codes while the space is not exhausted', () => {
    const m = new RoomManager(store, { now: () => now, makeEngine: () => fakeEngine() });
    const codes = new Set(Array.from({ length: 50 }, () => m.createRoom()));
    assert.equal(codes.size, 50, 'default rand is the CSPRNG, so no collisions at this scale');
    for (const code of codes) assert.match(code, /^[A-Z2-9]{4}$/);
    m.disposeAll();
  });
});
