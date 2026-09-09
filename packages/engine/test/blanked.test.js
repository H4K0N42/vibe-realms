// blankedIn() exists for one moment in the game: a player has drawn and not yet
// discarded, so they hold eight cards. score() rejects that hand outright, which
// used to leave the live "this card is dead" hint blank for the whole of the
// turn where it decides what to throw away.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { RoomEngine } from '../src/room-engine.js';

const BASILISK = 'FR37';   // BLANKS all Armies, Leaders, and other Beasts
const RANGERS = 'FR25';    // CLEARS the word Army from all Penalties
const KNIGHTS = 'FR21';    // Army
const WARHORSE = 'FR38';   // Beast
const MOUNTAIN = 'FR01';
const CANDLE = 'FR17';
const EMPRESS = 'FR35';    // Leader
const ELVEN_ARCHERS = 'FR22';

const SEVEN = [BASILISK, RANGERS, KNIGHTS, WARHORSE, MOUNTAIN, CANDLE, EMPRESS];
const EIGHT = [...SEVEN, ELVEN_ARCHERS];

describe('blankedIn', () => {
  it('answers for a hand of eight, which score() refuses', (t) => {
    const engine = new RoomEngine({ playerCount: 2 });
    t.after(() => engine.dispose());

    assert.throws(() => engine.score(EIGHT, []), /hand rejected/);
    // Basilisk kills the Beast and the Leader. The two Armies live: Rangers
    // clears the word Army from every penalty, which is the engine's own
    // reasoning and the reason this is not computed from the card text.
    assert.deepEqual(engine.blankedIn(EIGHT, []), [WARHORSE, EMPRESS]);
  });

  it('agrees with score() whenever score() will answer at all', (t) => {
    const engine = new RoomEngine({ playerCount: 2 });
    t.after(() => engine.dispose());

    const fromScore = engine.score(SEVEN, []).breakdown
      .filter((r) => r.blanked)
      .map((r) => r.cardId);
    assert.deepEqual(engine.blankedIn(SEVEN, []), fromScore);
  });

  it('leaves the hand limit in place for scoring afterwards', (t) => {
    const engine = new RoomEngine({ playerCount: 2 });
    t.after(() => engine.dispose());

    // The size gate is lifted per call by shadowing the vendored method on the
    // instance. If the override outlived the call, an eight-card hand would
    // quietly score here instead of being rejected.
    engine.blankedIn(EIGHT, []);
    assert.throws(() => engine.score(EIGHT, []), /hand rejected/);
    assert.equal(engine.score(SEVEN, []).breakdown.length, 7);
  });

  it('still rejects ids that are not a hand at all', (t) => {
    const engine = new RoomEngine({ playerCount: 2 });
    t.after(() => engine.dispose());

    assert.throws(() => engine.blankedIn([CANDLE, CANDLE], []), /duplicate/);
    assert.throws(() => engine.blankedIn([CANDLE], [CANDLE]), /both hand and discard/);
    assert.throws(() => engine.blankedIn(['FR99'], []), /unknown card id/);
  });
});
