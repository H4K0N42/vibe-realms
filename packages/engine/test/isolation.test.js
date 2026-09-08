// The reason this package exists. The vendored engine keeps its whole game state
// in process globals (`deck`, `hand`, `discard`), and enableCursedHoardSuits()
// DELETES the 8 base cards Cursed Hoard replaces. If rooms shared a realm, one
// room picking an expansion would corrupt every other live room.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { CURSED_HOARD_REPLACES, RoomEngine } from '../src/room-engine.js';

describe('per-room isolation', () => {
  it('a live Cursed Hoard room does not delete cards from a live base room', () => {
    const base = new RoomEngine({ playerCount: 4 });
    const ch = new RoomEngine({ cursedHoardSuits: true, playerCount: 4 });

    const baseIds = new Set(base.listCards().map((c) => c.id));
    const chIds = new Set(ch.listCards().map((c) => c.id));

    for (const id of CURSED_HOARD_REPLACES) {
      assert.ok(baseIds.has(id), `base room lost ${id}`);
      assert.ok(!chIds.has(id), `Cursed Hoard room still has replaced card ${id}`);
    }
    base.dispose();
    ch.dispose();
  });

  it('constructing a Cursed Hoard room mid-game does not change an existing room', () => {
    const base = new RoomEngine({ playerCount: 4 });
    const before = base.scoreByCode('FR03,FR17,FR32,FR43,FR46,FR47,FR49+FR49:FR47:Wizard').total;

    // Note FR25 is absent from Cursed Hoard rooms (CH19 replaces it), so each
    // room is exercised with a hand its own configuration actually contains.
    const others = [
      [new RoomEngine({ cursedHoardSuits: true, playerCount: 6 }), 'CH10,FR41,FR10,FR07,FR22,FR23+'],
      [new RoomEngine({ cursedHoardSuits: true, cursedHoardItems: true, playerCount: 2 }), 'CH08,FR32,FR37+CH08:FR32'],
      [new RoomEngine({ playerCount: 3 }), 'FR21,FR24,FR25,FR31,FR32,FR43,FR46+'],
    ];
    for (const [o, code] of others) o.scoreByCode(code);

    assert.equal(base.scoreByCode('FR03,FR17,FR32,FR43,FR46,FR47,FR49+FR49:FR47:Wizard').total, before);
    assert.equal(before, 380, 'rulebook example II');
    base.dispose();
    for (const [o] of others) o.dispose();
  });

  it('interleaved scoring across rooms stays independent', () => {
    const a = new RoomEngine({ playerCount: 4 });
    const b = new RoomEngine({ cursedHoardSuits: true, playerCount: 4 });
    const codeA = 'FR18,FR22,FR31,FR32,FR43,FR46,FR47+';
    const codeB = 'CH10,FR41,FR10,FR07,FR22,FR23+';

    for (let i = 0; i < 5; i++) {
      assert.equal(a.scoreByCode(codeA).total, 351);
      assert.equal(b.scoreByCode(codeB).total, 114);
    }
    a.dispose();
    b.dispose();
  });

  it('playerCount is per-room (CH24 Spyglass reads it strictly)', () => {
    const two = new RoomEngine({ cursedHoardSuits: true, cursedHoardItems: true, playerCount: 2 });
    const four = new RoomEngine({ cursedHoardSuits: true, cursedHoardItems: true, playerCount: 4 });
    // Same hand, different table size -> Spyglass should not score the same.
    const hand = 'CH24,FR22,FR31+';
    assert.notEqual(two.scoreByCode(hand).total, four.scoreByCode(hand).total);
    two.dispose();
    four.dispose();
  });

  it('rejects a playerCount outside 2-6', () => {
    assert.throws(() => new RoomEngine({ playerCount: 1 }), RangeError);
    assert.throws(() => new RoomEngine({ playerCount: 7 }), RangeError);
    assert.throws(() => new RoomEngine({ playerCount: '4' }), RangeError);
  });

  it('rejects cards that this room configuration does not have', () => {
    const ch = new RoomEngine({ cursedHoardSuits: true, playerCount: 4 });
    assert.throws(() => ch.score(['FR08', 'FR17']), /unknown card id/);
    ch.dispose();
  });

  it('rejects duplicate cards and hand/discard overlap', () => {
    const e = new RoomEngine({ playerCount: 4 });
    assert.throws(() => e.score(['FR01', 'FR01']), /duplicate/);
    assert.throws(() => e.score(['FR01'], ['FR01']), /both hand and discard/);
    e.dispose();
  });

  it('dispose() makes the engine unusable rather than silently wrong', () => {
    const e = new RoomEngine({ playerCount: 4 });
    e.dispose();
    assert.equal(e.disposed, true);
    assert.throws(() => e.listCards(), /disposed/);
  });

  it('hand limit is 7 in the base game and 8 with Cursed Hoard suits', () => {
    const base = new RoomEngine({ playerCount: 4 });
    const ch = new RoomEngine({ cursedHoardSuits: true, playerCount: 4 });
    assert.equal(base.handLimit, 7);
    assert.equal(ch.handLimit, 8);
    base.dispose();
    ch.dispose();
  });

  it('exactly one Phoenix variant is in play', () => {
    const plain = new RoomEngine({ cursedHoardSuits: true, playerCount: 4 });
    const promo = new RoomEngine({ cursedHoardSuits: true, phoenixPromo: true, playerCount: 4 });
    const ids = (e) => e.listCards().map((c) => c.id);
    assert.ok(ids(plain).includes('FR55') && !ids(plain).includes('FR55P'));
    assert.ok(ids(promo).includes('FR55P') && !ids(promo).includes('FR55'));
    plain.dispose();
    promo.dispose();
  });
});
