// End-to-end smoke test: real HTTP server, real websockets, the real node:vm
// scoring engine and real SQLite. Complements the unit suites, which stub the
// engine and the transport.
//
// Every socket buffers everything it receives; assertions wait for the first
// message *after* the action that caused it, so a broadcast queued earlier can
// never be mistaken for the response.
import assert from 'node:assert/strict';
import { WebSocket } from 'ws';

const BASE = process.env.FR_E2E_BASE ?? 'http://127.0.0.1:3999';
const WS = BASE.replace('http', 'ws') + '/ws';

function client(name) {
  const ws = new WebSocket(WS);
  const msgs = [];
  const waiters = [];
  ws.on('message', (raw) => {
    msgs.push(JSON.parse(String(raw)));
    for (const w of [...waiters]) {
      const found = msgs.slice(w.from).find(w.pred);
      if (found) {
        waiters.splice(waiters.indexOf(w), 1);
        w.resolve(found);
      }
    }
  });
  return {
    name, ws, msgs,
    mark: () => msgs.length,
    open: () => new Promise((r) => ws.once('open', r)),
    send: (m) => ws.send(JSON.stringify(m)),
    /**
     * First message at or after buffer position `from` matching `pred`.
     *
     * Predicates rather than bare message types: broadcasts triggered by *other*
     * players are in flight at unpredictable moments, so "the next hand message"
     * is not necessarily the one caused by the action under test. Waiting for the
     * expected shape is deterministic; a wrong shape times out and fails.
     */
    after(from, pred, label = 'message', ms = 5000) {
      const test = typeof pred === 'string' ? (m) => m.t === pred : pred;
      const found = msgs.slice(from).find(test);
      if (found) return Promise.resolve(found);
      return new Promise((resolve, reject) => {
        const w = { from, pred: test, resolve };
        waiters.push(w);
        setTimeout(() => {
          if (waiters.includes(w)) {
            waiters.splice(waiters.indexOf(w), 1);
            reject(new Error(`${name}: timed out waiting for ${typeof pred === 'string' ? pred : label}`));
          }
        }, ms);
      });
    },
    close: () => ws.close(),
  };
}

const health = await (await fetch(`${BASE}/api/health`)).json();
assert.equal(health.ok, true);

const { code } = await (await fetch(`${BASE}/api/rooms`, { method: 'POST', body: '{}' })).json();
assert.match(code, /^[A-Z0-9]{4}$/);
console.log(`room ${code}`);

const a = client('a');
const b = client('b');
await Promise.all([a.open(), b.open()]);

let m = a.mark();
a.send({ t: 'join', roomCode: code, nickname: 'Hagen' });
const joinedA = await a.after(m, 'joined');
m = b.mark();
b.send({ t: 'join', roomCode: code, nickname: 'Freund' });
await b.after(m, 'joined');

// --- deal -------------------------------------------------------------------
const markA = a.mark();
const markB = b.mark();
a.send({ t: 'start' });
const handA = await a.after(markA, (m) => m.t === 'hand' && m.cards.length === 7, 'A dealt 7');
const handB = await b.after(markB, (m) => m.t === 'hand' && m.cards.length === 7, 'B dealt 7');
assert.equal(handA.cards.length, 7, 'dealt 7 to A');
assert.equal(handB.cards.length, 7, 'dealt 7 to B');
assert.notDeepEqual(handA.cards, handB.cards, 'players got different cards');
assert.equal(new Set([...handA.cards, ...handB.cards]).size, 14, 'no card dealt twice');
for (const id of handA.cards) assert.match(id, /^(FR|CH)\d{2}P?$/);
console.log(`dealt 7+7 real cards, e.g. ${handA.cards.slice(0, 3).join(', ')}`);

// A must not be able to see B's cards anywhere.
const aSawPublicly = JSON.stringify(a.msgs.filter((x) => x.t !== 'hand'));
for (const card of handB.cards) {
  assert.ok(!aSawPublicly.includes(card), `B's card ${card} leaked to A`);
}
console.log('hidden information holds over a real socket');

// --- one full turn ----------------------------------------------------------
let mark = a.mark();
a.send({ t: 'draw', from: 'deck' });
const drawn = await a.after(mark, (m) => m.t === 'hand' && m.cards.length === 8, 'A holding 8');
assert.equal(drawn.cards.length, 8, 'holding 8 after drawing');

mark = a.mark();
const toss = drawn.cards[0];
a.send({ t: 'discard', cardId: toss });
const afterDiscard = await a.after(mark, (m) => m.t === 'state' && m.state.discard.length === 1, 'discard has 1');
const myHandAfter = await a.after(mark, (m) => m.t === 'hand' && m.cards.length === 7, 'A back to 7');
assert.equal(afterDiscard.state.discard.length, 1, 'discard area has the card');
assert.deepEqual(afterDiscard.state.discard, [toss]);
assert.notEqual(afterDiscard.state.turn, joinedA.playerId, 'turn passed to the other player');
assert.deepEqual(afterDiscard.state.players.map((p) => p.handCount), [7, 7]);
console.log('draw -> discard -> turn passes');

// --- turn enforcement -------------------------------------------------------
mark = a.mark();
a.send({ t: 'draw', from: 'deck' });
assert.equal((await a.after(mark, 'error')).code, 'NOT_YOUR_TURN');
console.log('out-of-turn move rejected');

// --- taking from the discard area ------------------------------------------
mark = b.mark();
b.send({ t: 'draw', from: 'discard', cardId: toss });
const bTook = await b.after(mark, (m) => m.t === 'hand' && m.cards.length === 8, 'B holding 8');
assert.ok(bTook.cards.includes(toss), 'B took the named discard');
const stateNow = await b.after(mark, (m) => m.t === 'state' && m.state.discard.length === 0, 'discard empty');
assert.equal(stateNow.state.discard.length, 0, 'card left the discard area');
console.log('taking a named card from the discard area works');

// --- reconnect --------------------------------------------------------------
a.close();
const a2 = client('a2');
await a2.open();
mark = a2.mark();
a2.send({ t: 'join', roomCode: code, nickname: 'Hagen', resumeToken: joinedA.resumeToken });
const rejoined = await a2.after(mark, 'joined');
const restored = await a2.after(mark, (m) => m.t === 'hand', 'restored hand');
assert.equal(rejoined.playerId, joinedA.playerId, 'same seat');
assert.deepEqual([...restored.cards].sort(), [...myHandAfter.cards].sort(), 'exact hand restored');
console.log('reconnect restores the same seat and hand');

a2.close();
b.close();
console.log('\nE2E OK');
process.exit(0);
