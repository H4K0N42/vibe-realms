// Plays a complete game to its natural end (discard area fills) against the real
// server and the real node:vm scoring engine, then checks the scores.
//
// The unit suites stub the engine, and the smoke test only plays two turns, so
// this is the only thing that exercises deal -> full turn loop -> action choices
// -> real scoring end to end.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { WebSocket } from 'ws';

const BASE = process.env.FR_E2E_BASE ?? 'http://127.0.0.1:3999';
const cards = JSON.parse(readFileSync('packages/carddata/data/cards.json', 'utf8'));
const ACTION_CARDS = new Set(cards.filter((c) => c.action).map((c) => c.id));
const CURSED_ITEMS = new Set(cards.filter((c) => c.set === 'cursed-items').map((c) => c.id));
const byId = new Map(cards.map((c) => [c.id, c]));

function client(name) {
  const ws = new WebSocket(BASE.replace('http', 'ws') + '/ws');
  const msgs = [];
  const waiters = [];
  ws.on('message', (raw) => {
    msgs.push(JSON.parse(String(raw)));
    for (const w of [...waiters]) {
      const hit = msgs.slice(w.from).find(w.pred);
      if (hit) { waiters.splice(waiters.indexOf(w), 1); w.resolve(hit); }
    }
  });
  return {
    name, msgs,
    mark: () => msgs.length,
    open: () => new Promise((r) => ws.once('open', r)),
    send: (m) => ws.send(JSON.stringify(m)),
    after(from, pred, label = 'message', ms = 10000) {
      const test = typeof pred === 'string' ? (m) => m.t === pred : pred;
      const hit = msgs.slice(from).find(test);
      if (hit) return Promise.resolve(hit);
      return new Promise((resolve, reject) => {
        const w = { from, pred: test, resolve };
        waiters.push(w);
        setTimeout(() => {
          if (waiters.includes(w)) {
            waiters.splice(waiters.indexOf(w), 1);
            reject(new Error(`${name}: timed out waiting for ${label}`));
          }
        }, ms);
      });
    },
    latest: (t) => [...msgs].reverse().find((m) => m.t === t),
    close: () => ws.close(),
  };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
/** Poll a predicate; the reveal advances through several broadcasts. */
async function sleepUntil(pred, ms = 5000) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (pred()) return;
    await sleep(40);
  }
  throw new Error('timed out waiting for state');
}

const settings = JSON.parse(process.env.FR_SETTINGS ?? '{}');
const { code } = await (await fetch(`${BASE}/api/rooms`, {
  method: 'POST', body: JSON.stringify(settings),
})).json();

const players = [client('A'), client('B'), client('C')];
await Promise.all(players.map((p) => p.open()));

const ids = [];
for (const [i, p] of players.entries()) {
  const m = p.mark();
  p.send({ t: 'join', roomCode: code, nickname: `P${i}` });
  ids.push((await p.after(m, 'joined')).playerId);
}

const startMark = players.map((p) => p.mark());
players[0].send({ t: 'start' });
for (const [i, p] of players.entries()) {
  const hand = await p.after(startMark[i], (m) => m.t === 'hand' && m.cards.length === 7, 'deal');
  assert.equal(hand.cards.length, 7);
}
console.log(`room ${code}: 3 players dealt`);

// --- play until the discard area fills --------------------------------------
let turns = 0;
while (turns < 60) {
  const state = players[0].latest('state').state;
  if (state.phase !== 'playing') break;

  const seat = ids.indexOf(state.turn);
  assert.notEqual(seat, -1, 'turn belongs to a known player');
  const me = players[seat];

  let mark = me.mark();
  me.send({ t: 'draw', from: 'deck' });
  const drawn = await me.after(mark, (m) => m.t === 'hand' && m.cards.length === 8, 'drew');

  mark = me.mark();
  me.send({ t: 'discard', cardId: drawn.cards[0] });
  await me.after(mark, (m) => m.t === 'state', 'state after discard');
  turns++;

  const now = players[0].latest('state').state;
  if (now.phase === 'scoring') break;
}
console.log(`played ${turns} turns, discard area full`);

// --- drive the reveal ------------------------------------------------------
// Scoring is a presentation now: one player at a time, card by card, in the
// order that player arranged their hand. Whoever is being revealed drives it;
// if they have dropped, anyone else may.
for (let guard = 0; guard < 400; guard++) {
  const view = players[0].latest('state')?.state;
  if (!view || view.phase !== 'scoring' || !view.reveal) break;
  const r = view.reveal;
  const seat = ids.indexOf(r.playerId);
  const driver = players[seat] ?? players[0];

  if (r.steps.length < r.handSize) {
    const mark = driver.mark();
    driver.send({ t: 'revealNext' });
    await driver.after(mark, (m) => m.t === 'state' && (m.state.reveal?.steps.length ?? 0) > r.steps.length,
      `card ${r.steps.length + 1} of ${r.handSize}`);
    continue;
  }
  if (r.pendingActions.length > 0) {
    for (const cardId of r.pendingActions) driver.send({ t: 'resolveAction', cardId, choice: null });
    await sleepUntil(() => (players[0].latest('state')?.state.reveal?.pendingActions.length ?? 0) === 0);
    continue;
  }
  const mark = driver.mark();
  driver.send({ t: 'revealFinish' });
  await driver.after(mark, (m) => m.t === 'state' || m.t === 'scores', 'reveal advanced');
}

const revealed = players[0].latest('state')?.state;
assert.ok(!revealed?.reveal, 'the reveal finished');
console.log('reveal completed for every player');

// The scores message follows the last state broadcast; wait for it rather than
// reading whatever happens to have arrived.
const scores = await players[0].after(0, 'scores', 'final scores');
console.log(`scored, reason=${scores.reason}`);

assert.equal(scores.scores.length, 3, 'every player scored');
for (const s of scores.scores) {
  assert.equal(typeof s.total, 'number');
  assert.ok(Number.isFinite(s.total), 'total is a real number');
  // 7 cards, plus one Cursed Item when that expansion is on: items live in
  // their own zone and do not count against the hand limit.
  const items = s.hand.filter((id) => CURSED_ITEMS.has(id));
  assert.equal(s.hand.length - items.length, 7, 'scored exactly 7 hand cards');
  assert.ok(items.length <= 1, 'at most one Cursed Item per player');
  assert.equal(s.breakdown.length, s.hand.length, 'breakdown covers every card');
  const sum = s.breakdown.reduce((n, r) => n + (r.blanked ? 0 : r.base + r.bonus + r.penalty), 0);
  assert.equal(sum, s.total, `breakdown sums to the total (${sum} vs ${s.total})`);
}
const totals = scores.scores.map((s) => s.total);
console.log('totals:', totals.join(', '));
assert.ok(totals.some((t) => t !== totals[0]) || totals[0] !== 0, 'scores are not all trivially zero');

// Hidden information must hold *while the game is being played*. The reveal
// deliberately makes every card public afterwards, which is the whole point of
// it, so the check stops at the moment scoring begins.
for (const [i, p] of players.entries()) {
  const untilScoring = p.msgs.findIndex((m) => m.t === 'state' && m.state.phase !== 'playing');
  const duringPlay = p.msgs.slice(0, untilScoring === -1 ? p.msgs.length : untilScoring);
  const publicOnly = JSON.stringify(duringPlay.filter((m) => m.t !== 'hand'));
  for (const [j, other] of players.entries()) {
    if (i === j) continue;
    for (const card of other.latest('hand').cards) {
      assert.ok(!publicOnly.includes(card), `P${j}'s card ${card} leaked to P${i} during play`);
    }
  }
}
console.log('no hand leaked while the game was being played');

for (const p of players) p.close();
console.log('\nFULL GAME OK');
process.exit(0);
