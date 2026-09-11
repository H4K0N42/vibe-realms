// Transport: one plain-HTTP server that serves the built client and upgrades
// /ws to websockets. TLS and proxying are handled outside (Pangolin).
import { randomUUID } from 'node:crypto';
import { createReadStream, existsSync, statSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { extname, join, normalize } from 'node:path';

import { WebSocketServer, type WebSocket } from 'ws';

import type { ServerMessage } from '@fr/shared';

import { openStore } from './db.ts';
import { GameError } from './game.ts';
import { RoomManager, type Connection } from './rooms.ts';
import { isClientMessage, isSettingsPatch } from './validate.ts';

const PORT = Number(process.env.PORT ?? 3000);
const DATA_DIR = process.env.FR_DATA_DIR ?? './data';
const STATIC_DIR = process.env.FR_STATIC_DIR ?? '../web/dist';
const SWEEP_INTERVAL_MS = 5 * 60 * 1000;

/**
 * Limits. Nothing here authenticates anybody: the room code is the only secret
 * in the product, so these exist to keep one anonymous client from spending the
 * whole server on itself.
 */
/** A real message is a few hundred bytes. `ws` defaults to 100 MiB. */
const MAX_WS_MESSAGE_BYTES = 64 * 1024;
/** Enough for a fast player plus drag updates, far below what a loop sends. */
const MAX_MESSAGES_PER_WINDOW = 120;
const MESSAGE_WINDOW_MS = 10_000;
/** Room creation is a write to disk, so it gets a tighter budget than moves. */
const MAX_ROOMS_PER_WINDOW = 10;
const ROOM_WINDOW_MS = 60_000;

/**
 * Fixed-window counter keyed by caller. Deliberately tiny and in-process: a
 * real limiter belongs in the reverse proxy, and this one only has to make
 * abuse slow enough to notice rather than stop a determined attacker.
 */
function windowedLimiter(max: number, windowMs: number) {
  const seen = new Map<string, { count: number; start: number }>();
  return (key: string, now: number): boolean => {
    const entry = seen.get(key);
    if (!entry || now - entry.start >= windowMs) {
      seen.set(key, { count: 1, start: now });
      // Opportunistic prune: this map is keyed by client address and would
      // otherwise be its own slow memory leak.
      if (seen.size > 10_000) {
        for (const [k, v] of seen) if (now - v.start >= windowMs) seen.delete(k);
      }
      return true;
    }
    entry.count += 1;
    return entry.count <= max;
  };
}

const roomCreateLimiter = windowedLimiter(MAX_ROOMS_PER_WINDOW, ROOM_WINDOW_MS);

/**
 * Who is asking. Pangolin sits in front and appends the real client to
 * X-Forwarded-For, so the last hop is the one to trust; the header is
 * attacker-controlled if the app is ever exposed directly, which is why the
 * room and message caps are enforced per connection as well.
 */
function clientKey(req: IncomingMessage): string {
  const forwarded = req.headers['x-forwarded-for'];
  const chain = Array.isArray(forwarded) ? forwarded.join(',') : forwarded;
  const last = chain?.split(',').pop()?.trim();
  return last || req.socket.remoteAddress || 'unknown';
}

/**
 * The client is a single-origin SPA with no inline script and no third-party
 * anything, so the policy can be as narrow as it looks. `style-src` allows
 * inline because React writes element styles for the drag animation.
 */
const SECURITY_HEADERS: Record<string, string> = {
  'content-security-policy':
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; " +
    "img-src 'self' data:; font-src 'self'; connect-src 'self' ws: wss:; " +
    "base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'x-frame-options': 'DENY',
};

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
  res.writeHead(200, {
    'content-type': MIME[extname(file)] ?? 'application/octet-stream',
    ...SECURITY_HEADERS,
  });
  createReadStream(file).pipe(res);
}

const server = createServer((req, res) => {
  if (req.method === 'POST' && req.url === '/api/rooms') {
    if (!roomCreateLimiter(clientKey(req), Date.now())) {
      res.writeHead(429, { 'retry-after': '60' }).end('slow down');
      return;
    }
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
      if (body.length > 4096) req.destroy();
    });
    req.on('end', () => {
      let settings: unknown = {};
      try {
        settings = body ? JSON.parse(body) : {};
      } catch {
        res.writeHead(400).end('bad json');
        return;
      }
      // Merged into the room state and written to disk, so it gets the same
      // shape check as anything arriving over the socket.
      if (!isSettingsPatch(settings)) {
        res.writeHead(400).end('bad settings');
        return;
      }
      try {
        const code = manager.createRoom(settings);
        res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ code }));
      } catch (err) {
        // Room limit or no free code: a server-capacity answer, not a bad
        // request, and never the unbounded retry loop this used to be.
        if (err instanceof GameError) {
          res.writeHead(503, { 'retry-after': '60' }).end('no room available');
          return;
        }
        throw err;
      }
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

const wss = new WebSocketServer({ server, path: '/ws', maxPayload: MAX_WS_MESSAGE_BYTES });

wss.on('connection', (socket: WebSocket, req: IncomingMessage) => {
  const conn: Connection = {
    id: randomUUID(),
    roomCode: null,
    playerId: null,
    send(message: ServerMessage) {
      if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(message));
    },
  };
  // Per socket, not per address: opening more sockets is the cheap way around
  // an address-keyed budget, and a socket is the thing a join is charged to.
  const allowMessage = windowedLimiter(MAX_MESSAGES_PER_WINDOW, MESSAGE_WINDOW_MS);
  const key = clientKey(req);

  socket.on('message', (raw) => {
    if (!allowMessage(key, Date.now())) {
      // Flooding is not a move the protocol has an error for. Nothing legitimate
      // hits this, and a client that does is not going to stop being told no.
      conn.send({ t: 'error', code: 'ILLEGAL_MOVE', message: 'too many messages' });
      socket.close(1008, 'rate limit');
      return;
    }
    let message: unknown;
    try {
      message = JSON.parse(String(raw));
    } catch {
      conn.send({ t: 'error', code: 'ILLEGAL_MOVE', message: 'malformed message' });
      return;
    }
    // The cast this used to do was a promise, not a check. Sizes are bounded
    // here; whether the move is legal is still game.ts's job.
    if (!isClientMessage(message)) {
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
