import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { DISCARD_LIMIT, DISCONNECT_GRACE_MS, type RoomSettings } from '@fr/shared';
import {
  addPlayer, createRoom, discard, draw, endVoteAvailable, publicState,
  removePlayer, setConnected, startGame, voteEndGame, type GameState,
} from '../src/game.ts';

const SETTINGS: RoomSettings = {
  expansions: { cursedHoardSuits: false, cursedHoardItems: false },
  locale: 'de',
};

/** Deterministic stand-in deck; the real one comes from the engine. */
const DECK = Array.from({ length: 53 }, (_, i) => `FR${String(i + 1).padStart(2, '0')}`);

function room(names: string[], t = 1000): GameState {
  const s = createRoom('ABCD', SETTINGS, t);
  names.forEach((n, i) => addPlayer(s, `p${i}`, n, t));
  return s;
}

function started(names: string[], t = 1000): GameState {
  const s = room(names, t);
  startGame(s, DECK, 7, t);
  return s;
}

/** Play one full legal turn for whoever is up. */
function playTurn(s: GameState, t: number): void {
  const p = s.players[s.turnIndex]!;
  draw(s, p.id, 'deck', undefined, t);
  discard(s, p.id, p.hand[0]!, t);
}

describe('lobby', () => {
  it('rejects a duplicate nickname regardless of case', () => {
    const s = room(['Hagen']);
    assert.throws(() => addPlayer(s, 'x', 'hagen', 1000), /NAME_TAKEN/);
  });

  it('rejects a 7th player', () => {
    const s = room(['a', 'b', 'c', 'd', 'e', 'f']);
    assert.throws(() => addPlayer(s, 'x', 'g', 1000), /ROOM_FULL/);
  });

  it('refuses to start below 2 players (no bots)', () => {
    const s = room(['solo']);
    assert.throws(() => startGame(s, DECK, 7, 1000), /NOT_ENOUGH_PLAYERS/);
  });

  it('deals 7 to each player and keeps the rest as draw pile', () => {
    const s = started(['a', 'b', 'c']);
    assert.deepEqual(s.players.map((p) => p.hand.length), [7, 7, 7]);
    assert.equal(s.drawPile.length, DECK.length - 21);
    assert.equal(s.phase, 'playing');
  });

  it('reseats players when someone leaves the lobby', () => {
    const s = room(['a', 'b', 'c']);
    removePlayer(s, 'p1', 1000);
    assert.deepEqual(s.players.map((p) => [p.nickname, p.seat]), [['a', 0], ['c', 2 - 1]]);
  });
});

describe('turn loop', () => {
  it('rejects a move from the player whose turn it is not', () => {
    const s = started(['a', 'b']);
    assert.throws(() => draw(s, 'p1', 'deck', undefined, 1001), /NOT_YOUR_TURN/);
  });

  it('requires draw before discard, and forbids drawing twice', () => {
    const s = started(['a', 'b']);
    assert.throws(() => discard(s, 'p0', s.players[0]!.hand[0]!, 1001), /draw before discarding/);
    draw(s, 'p0', 'deck', undefined, 1001);
    assert.throws(() => draw(s, 'p0', 'deck', undefined, 1002), /already drew/);
  });

  it('advances the turn after a discard', () => {
    const s = started(['a', 'b', 'c']);
    playTurn(s, 1001);
    assert.equal(s.players[s.turnIndex]!.id, 'p1');
  });

  it('takes any named card from the discard area, not just the top', () => {
    const s = started(['a', 'b']);
    playTurn(s, 1001); // p0 discards
    playTurn(s, 1002); // p1 discards
    const target = s.discard[0]!;
    draw(s, 'p0', 'discard', target, 1003);
    assert.ok(s.players[0]!.hand.includes(target));
    assert.ok(!s.discard.includes(target));
  });

  it('puts a drawn card where it was dropped, not always at the end', () => {
    const s = started(['a', 'b']);
    const before = [...s.players[0]!.hand];
    const drawn = draw(s, 'p0', 'deck', undefined, 1001, 3);
    assert.equal(s.players[0]!.hand[3], drawn);
    assert.deepEqual(s.players[0]!.hand.filter((c) => c !== drawn), before);
  });

  it('appends when no place is given, and when the one given is nonsense', () => {
    const ends = (index?: number) => {
      const s = started(['a', 'b']);
      const drawn = draw(s, 'p0', 'deck', undefined, 1001, index);
      return s.players[0]!.hand.indexOf(drawn);
    };
    assert.equal(ends(undefined), 7);
    assert.equal(ends(99), 7);      // past the end of the hand
    assert.equal(ends(-1), 7);
    assert.equal(ends(2.5), 7);     // not a place at all
    assert.equal(ends(0), 0);       // ...but the very front is a real answer
  });

  it('rejects taking a card that is not in the discard area', () => {
    const s = started(['a', 'b']);
    draw(s, 'p0', 'deck', undefined, 1001);
    assert.throws(() => draw(s, 'p0', 'discard', 'FR99', 1002), /already drew/);
  });

  it('ends the game when the discard area fills', () => {
    const s = started(['a', 'b']);
    let t = 1001;
    for (let i = 0; i < DISCARD_LIMIT; i++) playTurn(s, t++);
    assert.equal(s.discard.length, DISCARD_LIMIT);
    assert.equal(s.phase, 'scoring');
    assert.equal(s.endReason, 'discardPile');
  });
});

describe('hidden information', () => {
  it('never puts hands or draw-pile order in the public state', () => {
    const s = started(['a', 'b']);
    const pub = publicState(s, 1001);
    const json = JSON.stringify(pub);
    for (const card of s.players[0]!.hand) {
      assert.ok(!json.includes(card), `hand card ${card} leaked into public state`);
    }
    for (const card of s.drawPile) {
      assert.ok(!json.includes(card), `draw pile card ${card} leaked into public state`);
    }
    assert.deepEqual(pub.players.map((p) => p.handCount), [7, 7]);
    assert.equal(pub.drawPileCount, DECK.length - 14);
  });
});

describe('early end vote', () => {
  const GRACE = DISCONNECT_GRACE_MS;

  it('is unavailable while everyone is connected', () => {
    const s = started(['a', 'b', 'c']);
    assert.equal(endVoteAvailable(s, 1001), false);
    assert.equal(publicState(s, 1001).endVote, null);
  });

  it('is unavailable until the disconnect grace period has passed', () => {
    const s = started(['a', 'b', 'c']);
    setConnected(s, 'p2', false, 2000);
    assert.equal(endVoteAvailable(s, 2000 + GRACE - 1), false);
    assert.equal(endVoteAvailable(s, 2000 + GRACE), true);
  });

  it('needs every connected player, and then ends the game', () => {
    const s = started(['a', 'b', 'c']);
    setConnected(s, 'p2', false, 2000);
    const t = 2000 + GRACE;

    assert.equal(voteEndGame(s, 'p0', true, t), false);
    assert.equal(publicState(s, t).endVote?.needed, 2);
    assert.equal(s.phase, 'playing');

    assert.equal(voteEndGame(s, 'p1', true, t), true);
    assert.equal(s.phase, 'scoring');
    assert.equal(s.endReason, 'earlyVote');
  });

  it('lets the last player standing end a 2-player game alone', () => {
    const s = started(['a', 'b']);
    setConnected(s, 'p1', false, 2000);
    const t = 2000 + GRACE;
    assert.equal(publicState(s, t).endVote?.needed, 1);
    assert.equal(voteEndGame(s, 'p0', true, t), true);
    assert.equal(s.phase, 'scoring');
  });

  it('clears cast votes when the missing player reconnects', () => {
    const s = started(['a', 'b', 'c']);
    setConnected(s, 'p2', false, 2000);
    const t = 2000 + GRACE;
    voteEndGame(s, 'p0', true, t);
    assert.equal(s.players[0]!.votedEnd, true);

    setConnected(s, 'p2', true, t + 1);
    assert.equal(s.players[0]!.votedEnd, false);
    assert.equal(endVoteAvailable(s, t + 1), false);
    assert.equal(publicState(s, t + 1).endVote, null);
    assert.equal(s.phase, 'playing');
  });

  it('does not let a disconnected player vote', () => {
    const s = started(['a', 'b', 'c']);
    setConnected(s, 'p2', false, 2000);
    const t = 2000 + GRACE;
    assert.throws(() => voteEndGame(s, 'p2', true, t), /disconnected/);
  });

  it('refuses votes when no vote is open', () => {
    const s = started(['a', 'b']);
    assert.throws(() => voteEndGame(s, 'p0', true, 1001), /no early-end vote/);
  });

  it('keeps the disconnected player seated so their hand can still be scored', () => {
    const s = started(['a', 'b']);
    removePlayer(s, 'p1', 2000);
    assert.equal(s.players.length, 2);
    assert.equal(s.players[1]!.hand.length, 7);
    assert.equal(s.players[1]!.connected, false);
  });
});
