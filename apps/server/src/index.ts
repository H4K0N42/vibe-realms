// Transport: one plain-HTTP server that serves the built client and upgrades
// /ws to websockets. TLS and proxying are handled outside (Pangolin).
import { createReadStream, existsSync, statSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { extname, join, normalize } from 'node:path';

import { WebSocketServer, type WebSocket } from 'ws';

import type { ClientMessage, ServerMessage } from '@fr/shared';

import { openStore } from './db.ts';
import { RoomManager, type Connection } from './rooms.ts';

const PORT = Number(process.env.PORT ?? 3000);
const DATA_DIR = process.env.FR_DATA_DIR ?? './data';
const STATIC_DIR = process.env.FR_STATIC_DIR ?? '../web/dist';
const SWEEP_INTERVAL_MS = 5 * 60 * 1000;

const store = openStore(DATA_DIR);
const manager = new RoomManager(store);

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
  '.woff2': 'font/woff2',
  '.ico': 'image/x-icon',
};

function serveStatic(req: IncomingMessage, res: ServerResponse): void {
  const urlPath = new URL(req.url ?? '/', 'http://localhost').pathname;
  // normalize() + the prefix check keeps `../` out of the static root.
  const rel = normalize(decodeURIComponent(urlPath)).replace(/^(\.\.[/\\])+/, '');
  let file = join(STATIC_DIR, rel);
  if (!file.startsWith(normalize(STATIC_DIR))) {
    res.writeHead(403).end('forbidden');
    return;
  }
  if (!existsSync(file) || statSync(file).isDirectory()) {
    // SPA fallback: unknown paths are client-side routes.
    file = join(STATIC_DIR, 'index.html');
  }
  if (!existsSync(file)) {
    res.writeHead(404).end('not found');
    return;
  }
  res.writeHead(200, { 'content-type': MIME[extname(file)] ?? 'application/octet-stream' });
  createReadStream(file).pipe(res);
}

const server = createServer((req, res) => {
  if (req.method === 'POST' && req.url === '/api/rooms') {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
      if (body.length > 4096) req.destroy();
    });
    req.on('end', () => {
      let settings = {};
      try {
        settings = body ? JSON.parse(body) : {};
      } catch {
        res.writeHead(400).end('bad json');
        return;
      }
      const code = manager.createRoom(settings);
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ code }));
    });
    return;
  }
  if (req.url === '/api/health') {
    res.writeHead(200, { 'content-type': 'application/json' })
       .end(JSON.stringify({ ok: true, rooms: manager.roomCount }));
    return;
  }
  serveStatic(req, res);
});

const wss = new WebSocketServer({ server, path: '/ws' });

wss.on('connection', (socket: WebSocket) => {
  const conn: Connection = {
    id: Math.random().toString(36).slice(2),
    roomCode: null,
    playerId: null,
    send(message: ServerMessage) {
      if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(message));
    },
  };

  socket.on('message', (raw) => {
    let message: ClientMessage;
    try {
      message = JSON.parse(String(raw)) as ClientMessage;
    } catch {
      conn.send({ t: 'error', code: 'ILLEGAL_MOVE', message: 'malformed message' });
      return;
    }
    try {
      manager.handle(conn, message);
    } catch (err) {
      console.error('[ws] unhandled', err);
      conn.send({ t: 'error', code: 'ILLEGAL_MOVE', message: 'server error' });
    }
  });

  socket.on('close', () => manager.disconnect(conn));
  socket.on('error', () => manager.disconnect(conn));
});

const sweeper = setInterval(() => {
  try {
    manager.sweep();
  } catch (err) {
    console.error('[sweep]', err);
  }
}, SWEEP_INTERVAL_MS);
sweeper.unref();

server.listen(PORT, () => {
  console.log(`vibe-realms listening on http://0.0.0.0:${PORT} (data: ${DATA_DIR})`);
});

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    clearInterval(sweeper);
    wss.close();
    server.close(() => {
      manager.disposeAll();
      store.close();
      process.exit(0);
    });
  });
}
