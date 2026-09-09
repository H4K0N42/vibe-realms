// Persistence so a restart does not kill games in progress, plus the sweeper
// that stops the database growing forever (DESIGN.md "Storage").
//
// Uses node:sqlite, built into Node 24: no native module, so the Docker image
// needs no compiler.
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

import { ROOM_DELETE_AFTER_MS, ROOM_IDLE_MS } from '@fr/shared';

import type { GameState } from './game.ts';

export interface Store {
  save(state: GameState): void;
  load(code: string): GameState | null;
  loadAll(): GameState[];
  delete(code: string): void;
  /** token -> where that player sits. */
  putToken(token: string, code: string, playerId: string): void;
  resolveToken(token: string): { code: string; playerId: string } | null;
  /**
   * Marks rooms abandoned (everyone gone, or nobody has acted in ROOM_IDLE_MS)
   * and deletes ones abandoned longer than ROOM_DELETE_AFTER_MS.
   */
  sweep(now: number): { markedAbandoned: string[]; deleted: string[] };
  close(): void;
}

export function openStore(dataDir: string, filename = 'vibe-realms.sqlite'): Store {
  mkdirSync(dataDir, { recursive: true });
  const db = new DatabaseSync(join(dataDir, filename));
  db.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS rooms (
      code           TEXT PRIMARY KEY,
      phase          TEXT NOT NULL,
      state          TEXT NOT NULL,
      last_action_at INTEGER NOT NULL,
      abandoned_at   INTEGER
    );
    CREATE INDEX IF NOT EXISTS rooms_abandoned_at ON rooms (abandoned_at);
    CREATE TABLE IF NOT EXISTS player_tokens (
      token     TEXT PRIMARY KEY,
      code      TEXT NOT NULL,
      player_id TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS player_tokens_code ON player_tokens (code);
  `);

  const upsert = db.prepare(`
    INSERT INTO rooms (code, phase, state, last_action_at, abandoned_at)
    VALUES (?, ?, ?, ?, NULL)
    ON CONFLICT(code) DO UPDATE SET
      phase = excluded.phase,
      state = excluded.state,
      last_action_at = excluded.last_action_at,
      -- Any save is a sign of life: un-abandon the room so the sweeper's
      -- deletion clock stops. Without this a player rejoining a room that was
      -- already marked abandoned would still have it deleted underneath them.
      abandoned_at = NULL
  `);
  const selectOne = db.prepare('SELECT state FROM rooms WHERE code = ?');
  const selectAll = db.prepare('SELECT state FROM rooms');
  const deleteRoom = db.prepare('DELETE FROM rooms WHERE code = ?');
  const deleteTokens = db.prepare('DELETE FROM player_tokens WHERE code = ?');
  const insertToken = db.prepare(
    'INSERT INTO player_tokens (token, code, player_id) VALUES (?, ?, ?) ' +
      'ON CONFLICT(token) DO UPDATE SET code = excluded.code, player_id = excluded.player_id',
  );
  const selectToken = db.prepare('SELECT code, player_id FROM player_tokens WHERE token = ?');

  return {
    save(state) {
      upsert.run(state.code, state.phase, JSON.stringify(state), state.lastActionAt);
    },
    load(code) {
      const row = selectOne.get(code) as { state: string } | undefined;
      return row ? (JSON.parse(row.state) as GameState) : null;
    },
    loadAll() {
      return (selectAll.all() as { state: string }[]).map((r) => JSON.parse(r.state) as GameState);
    },
    delete(code) {
      deleteTokens.run(code);
      deleteRoom.run(code);
    },
    putToken(token, code, playerId) {
      insertToken.run(token, code, playerId);
    },
    resolveToken(token) {
      const row = selectToken.get(token) as { code: string; player_id: string } | undefined;
      return row ? { code: row.code, playerId: row.player_id } : null;
    },
    sweep(now) {
      // A room is abandoned when nobody is connected, or when nobody has acted
      // for ROOM_IDLE_MS: the "closed laptop" case, which would otherwise
      // leave a row sitting in the database forever.
      const markedAbandoned: string[] = [];
      for (const row of db.prepare('SELECT code, state, abandoned_at FROM rooms').all() as {
        code: string;
        state: string;
        abandoned_at: number | null;
      }[]) {
        if (row.abandoned_at !== null) continue;
        const state = JSON.parse(row.state) as GameState;
        const everyoneGone = state.players.length === 0 || state.players.every((p) => !p.connected);
        const idle = now - state.lastActionAt >= ROOM_IDLE_MS;
        if (everyoneGone || idle) {
          db.prepare('UPDATE rooms SET abandoned_at = ? WHERE code = ?').run(now, row.code);
          markedAbandoned.push(row.code);
        }
      }

      const stale = db
        .prepare('SELECT code FROM rooms WHERE abandoned_at IS NOT NULL AND abandoned_at <= ?')
        .all(now - ROOM_DELETE_AFTER_MS) as { code: string }[];
      const deleted = stale.map((r) => r.code);
      for (const code of deleted) {
        deleteTokens.run(code);
        deleteRoom.run(code);
      }
      return { markedAbandoned, deleted };
    },
    close() {
      db.close();
    },
  };
}

/** Clears the abandoned flag when someone comes back before deletion. */
export function reviveRoom(store: Store, code: string): void {
  const state = store.load(code);
  if (state) store.save(state);
}
