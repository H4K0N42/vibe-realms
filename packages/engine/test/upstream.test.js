// GENERATED from calculator/js/tests.js. Do not edit by hand.
// Regenerate with: node scripts/gen-upstream-tests.mjs
//
// 56 vectors from upstream's own suite, run against RoomEngine.
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import { RoomEngine } from '../src/room-engine.js';

describe('upstream vectors: base game', () => {
  /** @type {RoomEngine} */
  let engine;
  before(() => { engine = new RoomEngine({ playerCount: 4 }); });
  after(() => engine.dispose());

  it("Blizzard, Great Flood, Elven Archers", () => {
    assert.equal(engine.scoreByNames(["Blizzard","Great Flood","Elven Archers"]).total, 35);
  });
  it("Smoke, Dwarvish Infantry, War Dirigible", () => {
    assert.equal(engine.scoreByNames(["Smoke","Dwarvish Infantry","War Dirigible"]).total, 50);
  });
  it("Candle, Smoke, Dwarvish Infantry, War Dirigible", () => {
    assert.equal(engine.scoreByNames(["Candle","Smoke","Dwarvish Infantry","War Dirigible"]).total, 44);
  });
  it("FR21,FR24,FR25,FR31,FR32,FR43,FR46+", () => {
    assert.equal(engine.scoreByCode("FR21,FR24,FR25,FR31,FR32,FR43,FR46+").total, 265);
  });
  it("FR06,FR07,FR08,FR09,FR10,FR11,FR26+", () => {
    assert.equal(engine.scoreByCode("FR06,FR07,FR08,FR09,FR10,FR11,FR26+").total, 326);
  });
  it("Max score without special cards?", () => {
    assert.equal(engine.scoreByCode("FR18,FR22,FR31,FR32,FR43,FR46,FR47+").total, 351);
  });
  it("Rulebook example I", () => {
    assert.equal(engine.scoreByCode("FR01,FR08,FR13,FR14,FR15,FR16,FR52+FR52:FR11").total, 260);
  });
  it("Rulebook example II", () => {
    assert.equal(engine.scoreByCode("FR03,FR17,FR32,FR43,FR46,FR47,FR49+FR49:FR47:Wizard").total, 380);
  });
  it("Best hand ever?", () => {
    assert.equal(engine.scoreByCode("FR03,FR17,FR28,FR38,FR43,FR46,FR47,FR49+FR49:FR03:Leader").total, 397);
  });
  it("Second best", () => {
    assert.equal(engine.scoreByCode("FR02,FR03,FR05,FR17,FR26,FR28,FR47,FR49+FR49:FR17:Land").total, 388);
  });
  it("Second best", () => {
    assert.equal(engine.scoreByCode("FR03,FR17,FR28,FR32,FR43,FR46,FR47,FR49+FR49:FR03:Army").total, 388);
  });
  it("Worst hand ever?", () => {
    assert.equal(engine.scoreByCode("FR28,FR29,FR31,FR32,FR34,FR35,FR51,FR53+FR51:FR31,FR53:FR29").total, -74);
  });
  it("2 Basilisks should blank eachother", () => {
    assert.equal(engine.scoreByCode("FR37,FR53+FR53:FR37").total, 0);
  });
  it("2 Dwarvish Infantries should penalty eachother", () => {
    assert.equal(engine.scoreByCode("FR24,FR53+FR53:FR24").total, 26);
  });
  it("Island can be used even when blanked", () => {
    assert.equal(engine.scoreByCode("FR09,FR12,FR16,FR37+FR09:FR16").total, 95);
  });
  it("Elementals count their Doppelgänger", () => {
    assert.equal(engine.scoreByCode("FR10,FR53+FR53:FR10").total, 23);
  });
  it("Collector can score multiple sets", () => {
    assert.equal(engine.scoreByCode("FR26,FR27,FR30,FR36,FR38,FR39,FR40+").total, 193);
  });
  it("Collector does not score duplicated cards", () => {
    assert.equal(engine.scoreByCode("FR26,FR46,FR47,FR51,FR53+FR51:FR46,FR53:FR46").total, 20);
  });
  it("Gem of Order can score multiple sets", () => {
    assert.equal(engine.scoreByCode("FR22,FR31,FR36,FR43,FR44,FR46,FR47+").total, 206);
  });
  it("Gem of Order can score multiple identical sets", () => {
    assert.equal(engine.scoreByCode("FR46,FR47,FR02,FR05,FR25,FR32+").total, 105);
  });
  it("Blanking I", () => {
    assert.equal(engine.scoreByCode("FR16,FR49,FR11,FR12+FR49:FR12:flood").total, 11);
  });
  it("Blanking II", () => {
    assert.equal(engine.scoreByCode("FR12,FR08,FR16,FR49+FR49:FR12:beast").total, 3);
  });
  it("Blanking III", () => {
    assert.equal(engine.scoreByCode("FR49,FR41,FR37,FR21+FR49:FR37:flood").total, 73);
  });
  it("Blanking IV", () => {
    assert.equal(engine.scoreByCode("FR49,FR41,FR24,FR22+FR49:FR24:flood").total, 56);
  });
  it("Blanking V", () => {
    assert.equal(engine.scoreByCode("FR49,FR41,FR06,FR08,FR22+FR49:FR08:wizard").total, 82);
  });
  it("Blanking cycle (base case) - Rulebook Q&A", () => {
    assert.equal(engine.scoreByCode("FR08,FR12,FR16+").total, 65);
  });
  it("Blanking cycle (with cavern) - Rulebook Q&A", () => {
    assert.equal(engine.scoreByCode("FR02,FR08,FR12,FR16+").total, 62);
  });
  it("Blanking cycle (with book changing Blizzard to beast)", () => {
    assert.equal(engine.scoreByCode("FR08,FR12,FR16,FR49+FR49:FR12:beast").total, 3);
  });
  it("Blanking cycle (with cavern and book)", () => {
    assert.equal(engine.scoreByCode("FR02,FR08,FR12,FR16,FR49+FR49:FR12:beast").total, 9);
  });
  it("War Dirigible and Warship are blanked", () => {
    assert.equal(engine.scoreByCode("FR49,FR41,FR45,FR23,FR15+FR49:FR45:flood").total, 24);
  });
  it("War Dirigible does not need Army when Army cleared from penalty", () => {
    assert.equal(engine.scoreByCode("FR49,FR41,FR45+FR49:FR45:flood").total, 61);
  });
  it("War Dirigible does not need Army when Army cleared from penalty", () => {
    assert.equal(engine.scoreByCode("FR49,FR45,FR25+FR49:FR25:land").total, 53);
  });
  it("War Dirigible + Smoke", () => {
    assert.equal(engine.scoreByCode("FR21,FR45,FR13+").total, 47);
  });
  it("Smoke + War Dirigible", () => {
    assert.equal(engine.scoreByCode("FR21,FR13,FR45+").total, 47);
  });
});

describe('upstream vectors: Cursed Hoard suits + Phoenix', () => {
  /** @type {RoomEngine} */
  let engine;
  before(() => { engine = new RoomEngine({ cursedHoardSuits: true, playerCount: 4 }); });
  after(() => engine.dispose());

  it("CH10,FR41,FR10,FR07,FR22,FR23+", () => {
    assert.equal(engine.scoreByCode("CH10,FR41,FR10,FR07,FR22,FR23+").total, 114);
  });
  it("Angel", () => {
    assert.equal(engine.scoreByCode("CH08,FR32,FR37+CH08:FR32").total, 57);
  });
  it("Phoenix can not be blanked by any card except Floods", () => {
    assert.equal(engine.scoreByCode("FR55,FR37,FR16,FR11,CH08,FR49+CH08:FR16,FR49:FR37:wizard").total, 116);
  });
  it("Phoenix can not be blanked by Demon", () => {
    assert.equal(engine.scoreByCode("FR55,CH10+").total, 59);
  });
  it("Phoenix prevents blanking by Demon because of its bonus", () => {
    assert.equal(engine.scoreByCode("FR55,CH10,FR18,FR15+").total, 87);
  });
  // KNOWN DIVERGENCE: Beastmaster (FR27) clearsPenalty on beasts, and hand.js:233 skips blankedIf when penaltyCleared is set, so FR55 survives the Flood (64, not 41). FR55P is blanked in the same hand because the Flood names PHOENIX_PROMO in blanks(), a path that ignores penaltyCleared. Upstream is inconsistent between the two Phoenix printings; awaiting a rules decision.
  it.todo("Great Flood can still blank a Phoenix since it is a Flood", () => {
    assert.equal(engine.scoreByCode("CH18,FR55,FR27+").total, 41);
  });
  it("Phoenix can not blank any other card", () => {
    assert.equal(engine.scoreByCode("FR55,FR45,FR22+").total, 59);
  });
  it("Phoenix also counts as a Weather", () => {
    assert.equal(engine.scoreByCode("FR55,FR02,CH17,FR15,FR22,FR26,FR11+").total, 114);
  });
  it("Phoenix also counts as a Flame", () => {
    assert.equal(engine.scoreByCode("FR55,FR13,FR20,FR17,FR26+").total, 94);
  });
  it("Phoenix is a Flame and a Weather at the same time", () => {
    assert.equal(engine.scoreByCode("FR55,FR20,FR17,FR26,FR19,FR15,FR14,FR13+").total, 252);
  });
  it("Phoenix gives double bonus for Enchantress", () => {
    assert.equal(engine.scoreByCode("FR55,FR30+").total, 29);
  });
  it("Phoenix gives double penalty for Blizzard", () => {
    assert.equal(engine.scoreByCode("FR55,FR12+").total, 34);
  });
  it("Bonus of Phoenix prevents bonus of World Tree", () => {
    assert.equal(engine.scoreByCode("FR55,CH21,FR15+").total, 35);
  });
  it("Copy of a Phoenix only counts as a Beast", () => {
    assert.equal(engine.scoreByCode("FR55,FR20,FR15,CH22,FR53,FR26,FR27+CH22:FR55,FR53:FR55").total, 109);
  });
  it("Phoenix (Promo) also counts as a Weather", () => {
    assert.equal(engine.scoreByCode("FR55P,FR02,CH17,FR15,FR22,FR26,FR11+").total, 114);
  });
  it("Phoenix (Promo) also counts as a Flame", () => {
    assert.equal(engine.scoreByCode("FR55P,FR13,FR20,FR17,FR26+").total, 94);
  });
  it("Phoenix (Promo) is a Flame and a Weather at the same time", () => {
    assert.equal(engine.scoreByCode("FR55P,FR20,FR17,FR26,FR19,FR15,FR14,FR13+").total, 252);
  });
  it("Phoenix (Promo) gives double bonus for Enchantress", () => {
    assert.equal(engine.scoreByCode("FR55P,FR30+").total, 29);
  });
  it("Phoenix (Promo) gives double penalty for Blizzard", () => {
    assert.equal(engine.scoreByCode("FR55P,FR12+").total, 34);
  });
  it("Bonus of Phoenix (Promo) prevents bonus of World Tree", () => {
    assert.equal(engine.scoreByCode("FR55P,CH21,FR15+").total, 35);
  });
  it("Copy of a Phoenix (Promo) only counts as a Beast", () => {
    assert.equal(engine.scoreByCode("FR55P,FR20,FR15,CH22,FR53,FR26,FR27+CH22:FR55,FR53:FR55P").total, 109);
  });
  it("Phoenix (Promo) retains suits when blanked", () => {
    assert.equal(engine.scoreByCode("FR55P,FR10,FR20,FR15,FR36,FR38,FR26,CH05+").total, 132);
  });
});
