# Vibe Realms

A self-hosted, browser-based multiplayer implementation of the card game
*Fantasy Realms*, for playing with friends over the internet or a LAN. Two to
six players, one device each, no accounts and no app to install: one player
creates a room, the others follow a link.

The scoring engine is not a reimplementation. It is the upstream
[Fantasy Realms score calculator](https://github.com/fantasy-realms/fantasy-realms.github.io)
vendored byte for byte, so every card interaction scores exactly as that
calculator does, including the ones that defeat data-driven rule encodings
(Doppelgänger, Mirage, Shapeshifter, Book of Changes, Island, Angel). What this
project adds is the part the calculator never had: a game loop, turns, hidden
hands, a table and an endgame.

Private use. Card artwork is not included and no card scans are distributed.

## Features

- **2 to 6 players**, server-authoritative deck and hands, reconnect after a
  refresh or a crash.
- **All expansions**, selectable per room: Cursed Hoard suits (Building,
  Outsider, Undead) and Cursed Items.
- **Drag to play.** The draw pile is a face-down card you drag into your hand,
  and you discard by dragging a card into the discard area. Pointer events, so
  it works on phones. Cards are also fully operable by keyboard.
- **Hand order matters.** Cards are reorderable, and the end-of-game reveal
  turns them face up in the order you arranged them, one player at a time.
- **Live blanking hints.** Cards that are dead right now are struck through,
  and hovering a card shows what it interacts with in both directions, plus
  which cards it would blank.
- **14 languages of card text** (German and English interface), switchable
  mid-game.
- **Vote to end early** when a player has been disconnected for 60 seconds. The
  missing player is still scored and can still win.

## Running it

The whole thing is one container: static client plus websocket game server over
plain HTTP. TLS and proxying are expected to be handled in front of it.

```sh
docker compose up -d      # http://localhost:3000
```

Games live in SQLite on a named volume, so they survive a container replacement.
A room is marked abandoned when everyone leaves or after two hours without a
move, and is deleted an hour after that.

Configuration is three environment variables: `PORT` (default 3000),
`FR_DATA_DIR` (where the SQLite file goes) and `FR_STATIC_DIR` (the built
client). `/api/health` reports the room count and is what the container's
healthcheck calls.

## Developing

Node 22 or newer. The vendored engine and the generated card data are checked
in, so a clone builds without the submodule.

```sh
npm install
npm run dev      # server on :3000, Vite client on :5173 proxying to it
npm test         # 128 tests: engine, game state machine, rooms, storage
npm run build
```

End-to-end smoke test against a real server, real websockets, the real
`node:vm` engine and real SQLite:

```sh
PORT=3999 npm run dev --workspace @fr/server   # in one shell
npm run e2e                                    # in another
```

The client it drives looks for a server on `127.0.0.1:3999`; point it somewhere
else with `FR_E2E_BASE`.

### Layout

```
packages/shared     protocol and domain types (the contract)
packages/engine     node:vm-per-room wrapper plus vendor/ (never edited)
packages/carddata   generated card data and 14 locales of text
apps/server         game state machine, rooms, websockets, SQLite
apps/web            Vite + React client
scripts/            sync and codegen, e2e, a companion player for manual testing
```

### The submodule and `npm run sync`

`calculator/` is the upstream score calculator, pinned to a specific commit. It
is a source, not a dependency: nothing reads from it at runtime.

```sh
git submodule update --init
npm run sync
```

That re-derives everything from the pinned commit: the vendored engine files,
card data, translations, suit colours, the blanking relationships, and the
ported regression suite. It is run deliberately by a human and is *not* part of
the Docker build, so an image can never silently pick up upstream rule changes.

Upstream's own test suite is a browser page that renders red list items rather
than failing a build. Ported vectors that do not hold are emitted as
`it.todo` so they are reported on every run instead of being quietly deleted,
and each one is documented in [DESIGN.md](DESIGN.md).

## Design notes

[DESIGN.md](DESIGN.md) is the long version: why the engine runs in a fresh
`node:vm` context per room, how the drag physics and the hand reflow work, where
the colours come from, and every known divergence from upstream.

## Credit and licensing

The card game *Fantasy Realms* is designed by Bruce Glassco and published by
WizKids. This project is an unofficial, non-commercial implementation for
private play and is not affiliated with or endorsed by the publisher.

The vendored engine files under `packages/engine/vendor/` come from
`fantasy-realms/fantasy-realms.github.io`. Its `gh-pages` branch carries no
LICENSE file, so check the repository's default branch before reusing that code
in any form.
