// A second pair of hands for manual UI testing: joins a room and plays its own
// turns (draw from deck, discard the first card). Not a game AI, and not part of
// the product -- solo play and bots are explicitly out of scope.
import { WebSocket } from 'ws';

const BASE = process.env.FR_BASE ?? 'http://127.0.0.1:3000';
const code = process.argv[2];
const nickname = process.argv[3] ?? 'Freund';
if (!code) throw new Error('usage: companion-player.mjs <ROOMCODE> [nickname]');

const ws = new WebSocket(BASE.replace('http', 'ws') + '/ws');
let me = null;
let hand = [];

ws.on('open', () => ws.send(JSON.stringify({ t: 'join', roomCode: code, nickname })));
ws.on('message', (raw) => {
  const m = JSON.parse(String(raw));
  if (m.t === 'joined') { me = m.playerId; console.log(`${nickname} joined ${m.roomCode}`); }
  if (m.t === 'hand') hand = m.cards;
  if (m.t === 'error') console.log(`${nickname} error:`, m.code, m.message);
  if (m.t === 'scores') {
    console.log(`${nickname} sees final scores:`, m.scores.map((s) => s.total).join(' / '));
    process.exit(0);
  }
  if (m.t === 'state' && m.state.phase === 'playing' && m.state.turn === me) {
    setTimeout(() => {
      if (hand.length === 7) ws.send(JSON.stringify({ t: 'draw', from: 'deck' }));
      else if (hand.length === 8) ws.send(JSON.stringify({ t: 'discard', cardId: hand[0] }));
    }, 300);
  }
  if (m.t === 'state' && m.state.phase === 'scoring' && m.state.reveal) {
    const r = m.state.reveal;
    const mine = r.playerId === me;
    if (!mine) return; // the human drives their own reveal
    setTimeout(() => {
      if (r.steps.length < r.handSize) ws.send(JSON.stringify({ t: 'revealNext' }));
      else if (r.pendingActions.length > 0) {
        for (const cardId of r.pendingActions) {
          ws.send(JSON.stringify({ t: 'resolveAction', cardId, choice: null }));
        }
      } else ws.send(JSON.stringify({ t: 'revealFinish' }));
    }, 250);
  }
});
