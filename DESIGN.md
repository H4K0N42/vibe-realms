# Fantasy Realms — self-hosted multiplayer

Design agreed 2026-09-02. Status: **specced, not yet built.**

## What it is

A playable multiplayer Fantasy Realms in the browser, self-hosted, for private use.
Primary languages German and English. All expansions supported, selectable per room.

The `calculator/` submodule is a *separate, existing thing*: the upstream score
calculator. It is not replaced or modified — it is the source of truth for card
data, rules logic and translations.

## The submodule

`calculator/` = `fantasy-realms/fantasy-realms.github.io`, branch `gh-pages`,
**pinned at `fb722b2`**. Vanilla JS PWA (jQuery + Handlebars, no build step).

What it contains:

- `js/deck.js` (1579 lines) — all 103 cards: `FR01`–`FR55` + `FR55P` (Phoenix
  promo), `CH01`–`CH47` (Cursed Hoard: Building/Outsider/Undead suits, plus
  separate Cursed Items). Expansions toggle via `enableCursedHoardSuits()` /
  `enableCursedHoardItems()`.
- `js/hand.js`, `js/discard.js`, `js/combinatorics.js` — scoring engine.
  `bonusScore` / `penaltyScore` / `blanks` / `clearsPenalty` per card, and an
  `ACTION_ORDER` correctly sequencing Doppelgänger → Mirage → Shapeshifter →
  Book of Changes → Island → Angel. This is the hard part of the game, already solved.
- `i18n/Messages_*.properties` — 14 languages, German complete. Card names and
  effect text, containing `<span class="suit">` markup.
- `js/tests.js` + `tests.html` — regression suite.
- `js/find-scores.js` — "best possible hand" optimizer (browser-only, uses `window`).

What it does **not** contain:

- **Card artwork.** `img/` holds 5 files: background, two logos, a globe.
- **Any game loop.** No turn order, no draw, no endgame trigger. `discard.js` is
  only a discard-*area* tracker for scoring (several Cursed Hoard cards care what
  is in the discard area). Game flow is entirely ours to write.
- No LICENSE file on the `gh-pages` branch — worth checking `main` before relying
  on the vendored code, even for private use.

## Architecture

- Monorepo. **Vite + React + TypeScript SPA** ←`ws`→ **Node server**. Shared engine package.
- **Single Docker container**, plain HTTP. Pangolin handles proxy and TLS externally.
- Server is authoritative for the **shuffled deck order and hidden hands**.

### Engine reuse

Decision: reuse `deck.js` / `hand.js` / `discard.js` / `combinatorics.js`
**byte-for-byte unmodified**, in a fresh `node:vm` context **per room**.

Why the per-room context is mandatory: the engine is built on process globals —
`var hand = new Hand()` (`hand.js:397`), `var discard = new Discard()`
(`discard.js:99`), and a `deck` singleton whose `.cards` is mutated in place by
`enableCursedHoardSuits()`, which `delete`s the 8 base cards Cursed Hoard replaces
(FR03, FR06, FR08, FR25, FR28, FR48, FR51, FR52). Shared module scope would mean
one global game state for the entire server; a room enabling Cursed Hoard would
corrupt every other room's deck mid-game.

Agreed fallback if `vm` proves untenable: a **minimal patch** exporting factories
instead of singletons — not a rewrite. The function-based card definitions exist
because Book of Changes, Doppelgänger, Mirage and Shapeshifter defeat data-driven
rule encodings.

Vendoring: a `sync:engine` script **copies** the four files into
`packages/engine/vendor/` (checked in). Not read from the submodule path at
runtime — that would break the Docker build. Submodule stays pinned; upstream
updates are a deliberate, reviewable diff.

Upstream's `tests.js` is ported as the regression suite and must pass before any
game logic is written.

Note: `deck.js:1533` (`jQuery.i18n.prop` in `getCardsBySuit`) is the only browser
dependency in the engine files — a display-sort helper the server never calls.

### Client / server split

Card *definitions* (names, suits, strengths, effect text) are public rulebook data,
**bundled into the client at build time**. Lets the UI render instantly and compute
the optional score preview with no round trip.

Server-side only: **shuffled deck order and other players' hands**. Live game state
arrives over the websocket.

### i18n

Build-time script parses `Messages_*.properties` → typed JSON, checked in,
regenerated on submodule update. `i18next` on the client. **All 14 languages
shipped** (already written, few KB each, lazily loaded).

Effect text contains HTML. The `<span class="suit">` tags are parsed into real
components so suit colours follow our theme rather than upstream's CSS — not
injected as raw HTML.

### Storage

**SQLite.** Rooms, game state, reconnect tokens.

Lifecycle: a room is marked **abandoned** when all players quit, *or* after **2h
with no action from any player** (so a closed laptop doesn't leak a row forever).
Abandoned rooms are **deleted 1h later**.

### Identity

**No accounts.** Create room → short code → nickname → play. Reconnect cookie so a
refresh rejoins. Identity layer built so stats/history could attach later.

### Card art

Styled card components rendered from the i18n data — playable immediately, since
all text is already translated. Real scans layer in later as `FR01.jpg` /
`CH20.jpg`, with a crop-and-WebP script. Private use only, so scans are fine.

## Game rules and flow

7 cards in hand. On your turn: draw one (from deck or the face-up discard area),
then discard one. Game ends when the discard area fills; everyone scores their 7.

**2–6 players** (`js/app.js:290` → `playerCounts: [2, 3, 4, 5, 6]`). Player count is
an engine input — some cards score against it — so it is passed into the room's vm
context at game start. With no bots, a room cannot start below 2 humans.

- **Score preview:** per-room toggle, **default off**. Computing your own score is
  the skill of the game. Full breakdown always shown at endgame regardless.
- **Expansions:** selected per room in the lobby.
- **No solo play, no bots.** Cut from scope.

### Assumed, not explicitly confirmed by Hagen

These were recommended and not vetoed; revisit if they feel wrong in play.

- No turn timer.
- Disconnected players hold their seat indefinitely, shown with a "disconnected" badge.
- Discards require a confirm step (undo before commit) — a misclick is otherwise
  unrecoverable.

### Vote to end early

Second endgame path, alongside the normal discard-area trigger.

- **Trigger:** any player disconnected for **60s** (grace period, so a flaky phone
  doesn't summon it). Button appears for all still-connected players.
- **Reset:** if the missing player reconnects, the button hides and cast votes clear.
- **Threshold:** **unanimous among connected players.** With 2 players the remaining
  one ends it alone, which is correct. Vote progress shown live ("2 / 3 voted").
- **On pass:** game ends immediately, normal scoring and breakdown.
- **The disconnected player is still scored** and can still win. Ending early is a
  convenience for the remaining players, not a punishment — forfeiting would turn a
  dropped connection into a way to lose. *(Hagen's call to reverse.)*
- **Mid-turn edge case:** if they dropped holding 8 cards, score their **best 7-card
  subset** (8 combinations — trivial) rather than discarding arbitrarily for them.

## Out of scope / parked

Additive later, none blocking:

- Spectator mode
- Post-game "best possible hand" analysis via `find-scores.js`
- Accounts, stats, match history
- Solo play and bots — **explicitly cut, not parked**

## Status (2026-09-02)

Built and verified end to end. `npm test --workspaces` -> 108 tests, 107 pass,
0 fail, 1 todo (the Phoenix divergence below). `npm run e2e` runs a real browser-
less client against a real server; it also passes against the Docker image, and a
game in progress survives `docker restart`.

Layout:

    packages/shared     protocol + domain types (the contract)
    packages/engine     node:vm-per-room wrapper + vendor/ (never edited)
    packages/carddata   generated card data + 14 locales of text
    apps/server         game state machine, rooms, ws, SQLite
    apps/web            Vite + React client
    scripts/            sync-engine, extract-cards, sync-i18n,
                        gen-upstream-tests, e2e-smoke

`npm run sync` re-derives everything from the pinned submodule: vendored engine,
card data, translations, and the ported test suite.

Measured: a room costs ~1ms and ~0.2MB, so 50 concurrent rooms is ~11MB. Note the
heap does not drop immediately after `dispose()` -- V8 does not reclaim vm
contexts eagerly. Not a problem at this scale, but it is not zero either.

### Known gaps

Real and deliberate, not oversights:

- **App chrome is German-only.** All 103 cards are fully localised in 14
  languages, but button labels ("Neues Spiel", "Beitreten") are hardcoded German.
  The `ui` keys from upstream are already parsed into the locale files and unused.
- **Score preview is a setting with no renderer.** The per-room toggle exists and
  round-trips, but the table does not yet show a live score. The card data needed
  to compute it client-side is already bundled.
- **Card art.** Styled components only, as planned. `FR01.jpg` / `CH20.jpg` scans
  drop in later behind an optional field.
- **Cursed Items are dealt one per player** from their own deck into a separate
  zone (they do not count against the hand limit). Worth confirming against the
  physical rules -- this is the one expansion rule inferred rather than read.
- **German is missing the Phoenix (FR55)**, and Italian has no Cursed Hoard at
  all (55 of 103 cards). Missing text falls back to English per card, marked with
  a small "EN" badge. Upstream's data, not ours; supplying the German Phoenix
  text would fix it at the source.


## Hand order and the end-of-game reveal

Cards in your hand are reorderable by dragging, and the order is not cosmetic:
the end-of-game reveal turns them face up in exactly that order, so you arrange
your hand to tell the story you want.

There are no draw/discard buttons: the draw pile is a face-down card you drag
into your area, and you discard by dragging a card into the discard zone. Zones
declare themselves with `data-zone` and are hit-tested on release, so one engine
covers deck -> hand, discard -> hand, hand -> discard and reordering within the
hand.

Dragging uses pointer events, not HTML5 drag-and-drop, because HTML5 DnD does
not fire on touch devices and this gets played on phones. Listeners sit on the
window while a card is held, since a drag crosses zones and leaves the element
it started on.

The feel is modelled on moving an app window on iOS: a card resists until it is
either held for ~190ms or moved ~16px, then breaks loose. On breaking loose the
grab point eases to the card's middle over ~170ms, so the card visibly snaps
under the pointer instead of jumping, and it then follows at 26% catch-up per
frame, which reads as weight rather than a rigidly attached cursor.

Note this replaces the old confirm-before-discard step: the drag gesture is
deliberate enough on its own, and a confirmation bar in the middle of a drag
would break the flow.

The reveal runs **one player at a time, in seat order**; everyone watches the
same card. Per card the server rescores the prefix that is face up -- Fantasy
Realms scoring is not additive, since a later card can blank or rescue earlier
ones -- and the client animates the difference: a line strikes through cards that just
got blanked while the art desaturates, a floating "frei!" when one is rescued,
and +/- badges on the cards that changed. The running total sits in the middle
at the top.

### Layout

Hands are laid out as a grid of **eight fixed columns**, not a wrapping flex
row. Eight is the largest a hand ever gets (Necromancer, or mid-turn before
discarding), so drawing a card never resizes or rewraps the row -- the cards
simply are one eighth wide, before and after. The reveal row uses the same grid,
so a hand reads identically while playing and while being scored.

The discard area shows **all ten places it can hold** as two rows of five, empty
ones as dashed outlines, so how close the game is to ending is visible without
reading a counter. Those cards are full size with their rules text, exactly like
a card in hand: one `--card-w` drives the whole table, clamped for small screens,
and every grid is laid out in multiples of it. Eight fit across a hand, five
across a discard row.

Cards have a **hardcoded 5:7 aspect ratio** so a long rules text can never
stretch one into a tall column. Text that would not fit is handled by stepping
the type down (two thresholds, by character count) rather than by clipping;
whatever still overflows fades out, and hovering drops the ratio so the card
grows over its neighbours and can always be read in full.

### Hovering a card

Hovering links a card to the rest of the table **in both directions**:

- conditions on other cards that refer to the hovered one light up (by suit, or
  by name in the current language);
- and the other way round -- hovering "+20 for each Army" lights up the word
  ARMY on every Army card, and naming a specific card lights up that card's name.

Both directions read `relatedSuits` / `relatedCards` from the card data rather
than trusting the colours in the text, because a card named in someone's rules
text is painted in *its own* suit colour. Cavern's "+25 with Dwarvish Infantry or
Dragon" paints Dwarvish Infantry as an Army, so a naive suit comparison lit it up
whenever any Army was hovered -- even though Cavern means that one card. Names
called out by a card are collected per card and matched by name only; everything
else is treated as a category.

The hovered card is matched against itself as well, so "+15 for each other Land"
lights up LAND on the card saying it, not only on the other Lands.

Cards are plain elements, not buttons. They are dragged rather than pressed, and
rendering them as disabled buttons left the whole table looking greyed out and
inert.

The background image is wider than the element, so it is set to `no-repeat`:
with the default tiling the band reappeared a second time near the end of every
pass.

A shimmer runs **continuously** while the card is hovered: the text sits at its
bright colour throughout and a lighter band travels across it on a 1.5s loop, so
nothing ever drops back to the resting colour mid-pass. That needs a third
brightness per suit (`--suit-*-hot`), generated alongside the others by
`scripts/sync-colours.mjs`.

Ending the hover does not cut the animation off. `useSweep` keeps it running and
clears it on the next `animationiteration`, so the pass in flight always
completes and the text settles at a whole cycle rather than snapping back
mid-band. `animationiteration` bubbles, so one handler on the card body covers
every highlighted reference in it -- they start together and stay in step. The
last match is held alive for that tail, otherwise there would be nothing left to
light while it finishes.

This is a mouse affordance; touch devices have no hover, and the drag gesture is
what carries there. `prefers-reduced-motion` drops the sweep.

The draw pile is unlabelled: a face-down card is self-explanatory, and the count
sits quietly in its corner rather than filling the card.

Below 900px the grids drop to four and five columns.

### Suit colours

The palette is not ours: `scripts/sync-colours.mjs` reads `--land-color`,
`--flame-color` and the rest straight out of `calculator/css/style.css` and
writes `apps/web/src/suits.css`, so a submodule update carries the colours over.

Upstream paints suits as backgrounds on light cards, so several are very dark
(`--army-color #312b2f`, `--land-color #3b1d13`) and would vanish as text on our
dark background. Each colour therefore gets a second `--suit-*-ink` variant:
white mixed in, a step at a time, only until it clears WCAG AA (4.5:1) against
the panel background. Six of the fifteen already pass and are left untouched.

Filled elements -- the suit chip on a card -- use the exact upstream colour.
Text and borders use the ink variant. Same hue either way.

Cards the newest one interacts with light up **in that card's own suit colour**
-- a Flame lights its targets in red, a Leader in gold. Relevance comes from
upstream's own `relatedSuits` / `relatedCards` links (extracted into
`packages/carddata`), checked in both directions, plus any card whose score
actually changed.

Whoever is being revealed drives their own reveal. If they have dropped, anyone
still connected may advance it, so one closed laptop cannot freeze the table.

Action cards (Insel, Buch der Veränderung, Doppelgänger, Spiegelung,
Gestaltwandler, Engel) are answered **after** the hand is fully open, in the
bottom third. Their targets are not revealed before that: `pendingActions` stays
empty until every card is face up, otherwise the panel would betray what the
player is holding. Choosing rescores immediately, so the total reacts to the
choice instead of only showing up in the final table.


## Known divergences from upstream

Upstream's test suite is a browser page that renders red `<li>` elements rather
than failing a build, so a stale expectation there is easy to miss. Our port runs
the same vectors under `node --test`; ones that do not hold are emitted as
`it.todo` (reported every run, never silently deleted) and listed here.

### Phoenix + Great Flood + Beastmaster

Upstream vector: `CH18,FR55,FR27+` expected **41**, we compute **64**.
Reproduced against the raw vendored files with no wrapper involved, so this is
upstream behaviour, not a porting bug.

- `FR55` Phoenix (suit `beast`) carries `blankedIf: hand.containsSuit('flood')`.
- `FR27` Beastmaster has `clearsPenalty: card.suit === 'beast'`.
- `hand.js:233` skips `blankedIf` entirely when `card.penaltyCleared` is set.

So Beastmaster clears Phoenix's blanking and Phoenix survives the Flood.
Without Beastmaster, `CH18,FR55+` correctly blanks Phoenix (32). By the printed
rules this looks right: blanking text sits in the Penalty section of the card, and
Beastmaster clears the Penalty on all Beasts.

The real inconsistency is between the two Phoenix printings. In the identical hand
`FR55` scores 64 but `FR55P` scores 50, because the Flood cards name
`PHOENIX_PROMO` explicitly in `blanks()` — a code path that never consults
`penaltyCleared`. The two cards are meant to be the same card.

**Open question for Hagen** (he owns the physical cards): does Beastmaster's
"CLEARS the Penalty on all Beasts" cancel Phoenix's "BLANKED if you have any
Flood"? Until answered, we ship upstream's behaviour unmodified — which means
FR55 and FR55P disagree in this one exotic hand.

## Working agreement

If a better solution turns up while building, or something specced here stops
making sense once it meets real code — **ask before diverging.** Don't silently
implement something different, and don't grimly implement something that has
become wrong. Raise it, get a decision, and update this document.
