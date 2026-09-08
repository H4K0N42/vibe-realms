import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';

import { ROOM_DELETE_AFTER_MS, ROOM_IDLE_MS, type RoomSettings } from '@fr/shared';
import { openStore, type Store } from '../src/db.ts';
import { addPlayer, createRoom, setConnected, startGame } from '../src/game.ts';

const SETTINGS: RoomSettings = {
  expansions: { cursedHoardSuits: false, cursedHoardItems: false, phoenixPromo: false },
  scorePreview: false,
  locale: 'de',
};
const DECK = Array.from({ length: 53 }, (_, i) => `FR${String(i + 1).padStart(2, '0')}`);

let dir: string;
let store: Store;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'fr-test-'));
  store = openStore(dir);
});
afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

function liveRoom(code: string, t: number) {
  const s = createRoom(code, SETTINGS, t);
  addPlayer(s, 'p0', 'a', t);
  addPlayer(s, 'p1', 'b', t);
  startGame(s, DECK, 7, t);
  return s;
}

describe('store', () => {
  it('round-trips a game in progress, hands included', () => {
    const s = liveRoom('ABCD', 1000);
    store.save(s);
    const back = store.load('ABCD');
    assert.deepEqual(back?.players.map((p) => p.hand), s.players.map((p) => p.hand));
    assert.equal(back?.phase, 'playing');
  });

  it('resolves a resume token back to a seat', () => {
    store.putToken('tok-1', 'ABCD', 'p0');
    assert.deepEqual(store.resolveToken('tok-1'), { code: 'ABCD', playerId: 'p0' });
    assert.equal(store.resolveToken('nope'), null);
  });
});

describe('sweeper', () => {
  it('marks a room abandoned once everyone is disconnected', () => {
    const s = liveRoom('ABCD', 1000);
    setConnected(s, 'p0', false, 1000);
    setConnected(s, 'p1', false, 1000);
    store.save(s);
    assert.deepEqual(store.sweep(2000).markedAbandoned, ['ABCD']);
  });

  it('leaves a room alone while someone is still connected and active', () => {
    store.save(liveRoom('ABCD', 1000));
    assert.deepEqual(store.sweep(2000).markedAbandoned, []);
  });

  it('marks a room abandoned after the idle timeout even if nobody left', () => {
    // The closed-laptop case: still "connected", but nobody has acted.
    store.save(liveRoom('ABCD', 1000));
    assert.deepEqual(store.sweep(1000 + ROOM_IDLE_MS).markedAbandoned, ['ABCD']);
  });

  it('deletes a room only after the deletion delay, not before', () => {
    const s = liveRoom('ABCD', 1000);
    setConnected(s, 'p0', false, 1000);
    setConnected(s, 'p1', false, 1000);
    store.save(s);

    const abandonedAt = 2000;
    store.sweep(abandonedAt);
    assert.deepEqual(store.sweep(abandonedAt + ROOM_DELETE_AFTER_MS - 1).deleted, []);
    assert.deepEqual(store.sweep(abandonedAt + ROOM_DELETE_AFTER_MS).deleted, ['ABCD']);
    assert.equal(store.load('ABCD'), null);
  });

  it('drops resume tokens with the room so they cannot be reused', () => {
    const s = liveRoom('ABCD', 1000);
    setConnected(s, 'p0', false, 1000);
    setConnected(s, 'p1', false, 1000);
    store.save(s);
    store.putToken('tok-1', 'ABCD', 'p0');
    store.sweep(2000);
    store.sweep(2000 + ROOM_DELETE_AFTER_MS);
    assert.equal(store.resolveToken('tok-1'), null);
  });

  it('un-abandons a room when a player comes back before deletion', () => {
    const s = liveRoom('ABCD', 1000);
    setConnected(s, 'p0', false, 1000);
    setConnected(s, 'p1', false, 1000);
    store.save(s);
    store.sweep(2000);

    setConnected(s, 'p0', true, 3000);
    s.lastActionAt = 3000;
    store.save(s);

    assert.deepEqual(store.sweep(2000 + ROOM_DELETE_AFTER_MS).deleted, []);
    assert.ok(store.load('ABCD'));
  });
});
