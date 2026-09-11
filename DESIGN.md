# Fantasy Realms: self-hosted multiplayer

Design agreed 2026-09-02. Status: **built and playable**; see the status and
2026-09-08 sections below for what is and is not done.

## What it is

A playable multiplayer Fantasy Realms in the browser, self-hosted, for private use.
Primary languages German and English. All expansions supported, selectable per room.

The `calculator/` submodule is a *separate, existing thing*: the upstream score
calculator. It is not replaced or modified; it is the source of truth for card
data, rules logic and translations.

## The submodule

`calculator/` = `fantasy-realms/fantasy-realms.github.io`, branch `gh-pages`,
**pinned at `fb722b2`**. Vanilla JS PWA (jQuery + Handlebars, no build step).

What it contains:

- `js/deck.js` (1579 lines) holds all 103 cards: `FR01`-`FR55` + `FR55P` (Phoenix
  promo), `CH01`-`CH47` (Cursed Hoard: Building/Outsider/Undead suits, plus
  separate Cursed Items). Expansions toggle via `enableCursedHoardSuits()` /
  `enableCursedHoardItems()`.
- `js/hand.js`, `js/discard.js`, `js/combinatorics.js`: the scoring engine.
  `bonusScore` / `penaltyScore` / `blanks` / `clearsPenalty` per card, and an
  `ACTION_ORDER` correctly sequencing Doppelgänger → Mirage → Shapeshifter →
  Book of Changes → Island → Angel. This is the hard part of the game, already solved.
- `i18n/Messages_*.properties`: 14 languages, German complete. Card names and
  effect text, containing `<span class="suit">` markup.
- `js/tests.js` + `tests.html`: the regression suite.
- `js/find-scores.js`: the "best possible hand" optimizer (browser-only, uses `window`).

What it does **not** contain:

- **Card artwork.** `img/` holds 5 files: background, two logos, a globe.
- **Any game loop.** No turn order, no draw, no endgame trigger. `discard.js` is
  only a discard-*area* tracker for scoring (several Cursed Hoard cards care what
  is in the discard area). Game flow is entirely ours to write.
- No LICENSE file on the `gh-pages` branch, so check `main` before relying on
  the vendored code, even for private use.

## Architecture

- Monorepo. **Vite + React + TypeScript SPA** ←`ws`→ **Node server**. Shared engine package.
- **Single Docker container**, plain HTTP. Pangolin handles proxy and TLS externally.
- Server is authoritative for the **shuffled deck order and hidden hands**.

### Engine reuse

Decision: reuse `deck.js` / `hand.js` / `discard.js` / `combinatorics.js`
**byte-for-byte unmodified**, in a fresh `node:vm` context **per room**.

Why the per-room context is mandatory: the engine is built on process globals:
`var hand = new Hand()` (`hand.js:397`), `var discard = new Discard()`
(`discard.js:99`), and a `deck` singleton whose `.cards` is mutated in place by
`enableCursedHoardSuits()`, which `delete`s the 8 base cards Cursed Hoard replaces
(FR03, FR06, FR08, FR25, FR28, FR48, FR51, FR52). Shared module scope would mean
one global game state for the entire server; a room enabling Cursed Hoard would
corrupt every other room's deck mid-game.

Agreed fallback if `vm` proves untenable: a **minimal patch** exporting factories
instead of singletons, not a rewrite. The function-based card definitions exist
because Book of Changes, Doppelgänger, Mirage and Shapeshifter defeat data-driven
rule encodings.

Vendoring: a `sync:engine` script **copies** the four files into
`packages/engine/vendor/` (checked in). Not read from the submodule path at
runtime; that would break the Docker build. Submodule stays pinned; upstream
updates are a deliberate, reviewable diff.

Upstream's `tests.js` is ported as the regression suite and must pass before any
game logic is written.

Note: `deck.js:1533` (`jQuery.i18n.prop` in `getCardsBySuit`) is the only browser
dependency in the engine files: a display-sort helper the server never calls.

### Client / server split

Card *definitions* (names, suits, strengths, effect text) are public rulebook data,
**bundled into the client at build time**. Lets the UI render instantly and answer
"what does this card interact with" without a round trip.

Server-side only: **shuffled deck order and other players' hands**. Live game state
arrives over the websocket.

### i18n

Build-time script parses `Messages_*.properties` → typed JSON, checked in,
regenerated on submodule update. `i18next` on the client. **All 14 languages
shipped** (already written, few KB each, lazily loaded).

Effect text contains HTML. The `<span class="suit">` tags are parsed into real
components so suit colours follow our theme rather than upstream's CSS, and not
injected as raw HTML.

### Storage

**SQLite.** Rooms, game state, reconnect tokens.

Lifecycle: a room is marked **abandoned** when all players quit, *or* after **2h
with no action from any player** (so a closed laptop doesn't leak a row forever).
Abandoned rooms are **deleted 1h later**.

### Identity

The start screen has a **single** button: with the code field empty it reads
"Neues Spiel" and creates a room; typing anything into it turns the button into
"Beitreten", enabled once the code is complete. The two actions are never both
relevant, and offering both invited picking the wrong one. Enter in the code
field does the same thing.

**No accounts.** Create room → short code → nickname → play. Reconnect cookie so a
refresh rejoins. Identity layer built so stats/history could attach later.

### Card art

Styled card components rendered from the i18n data, playable immediately, since
all text is already translated. Real scans layer in later as `FR01.jpg` /
`CH20.jpg`, with a crop-and-WebP script. Private use only, so scans are fine.

## Game rules and flow

7 cards in hand. On your turn: draw one (from deck or the face-up discard area),
then discard one. Game ends when the discard area fills; everyone scores their 7.

**2-6 players** (`js/app.js:290` → `playerCounts: [2, 3, 4, 5, 6]`). Player count is
an engine input (some cards score against it), so it is passed into the room's vm
context at game start. With no bots, a room cannot start below 2 humans.

- **No score preview.** Working out your own score is the skill of the game; the
  full breakdown is shown at endgame. A per-room toggle for a live preview was
  specced and built as a setting, but never had a renderer, so the lobby offered
  a checkbox that did nothing. Removed rather than left lying (2026-09-08).
- **No Phoenix at all.** `FR55P` was offered as a third expansion checkbox.
  Removed by owner decision (2026-09-08): the setting, the checkbox and its two
  strings are gone, and `ExpansionConfig` is down to the two Cursed Hoard flags.
  The base Phoenix `FR55` followed on 2026-09-11, the same call: it is
  the one card upstream has no German text for, so a German table met it as
  English with an "EN" badge, and it is the card the two printings disagree
  about (see "Known divergences"). Both ids sit in `NOT_DEALT` in
  `apps/server/src/engine.ts`, which is the product layer: the deck is 54 cards
  instead of 55, and 69 with all of Cursed Hoard. `@fr/engine` still knows both
  cards and keeps its `phoenixPromo` option, because that mirrors a switch
  upstream itself offers and `isolation.test.js` and the upstream vectors cover
  it. Removing a card from the vendored deck was never on the table.
- **Expansions:** selected per room in the lobby.
- **No solo play, no bots.** Cut from scope.

### Assumed, not explicitly confirmed

These were recommended and not vetoed; revisit if they feel wrong in play.

- No turn timer.
- Disconnected players hold their seat indefinitely, shown with a "disconnected" badge.
- ~~Discards require a confirm step (undo before commit), since a misclick is
  otherwise unrecoverable.~~ Superseded by the drag gesture; see "Hand order and
  the end-of-game reveal" below.

### Vote to end early

Second endgame path, alongside the normal discard-area trigger.

- **Trigger:** any player disconnected for **60s** (grace period, so a flaky phone
  doesn't summon it). Button appears for all still-connected players.
- **Reset:** if the missing player reconnects, the button hides and cast votes clear.
- **Threshold:** **unanimous among connected players.** With 2 players the remaining
  one ends it alone, which is correct. Vote progress shown live ("2 / 3 voted").
- **On pass:** game ends immediately, normal scoring and breakdown.
- **The disconnected player is still scored** and can still win. Ending early is a
  convenience for the remaining players, not a punishment: forfeiting would turn a
  dropped connection into a way to lose. *(Owner's call to reverse.)*
- **Mid-turn edge case:** if they dropped holding 8 cards, score their **best 7-card
  subset** (8 combinations, trivial) rather than discarding arbitrarily for them.

## Out of scope / parked

Additive later, none blocking:

- Spectator mode
- Post-game "best possible hand" analysis via `find-scores.js`
- Accounts, stats, match history
- Solo play and bots: **explicitly cut, not parked**

## Status (2026-09-02)

Built and verified end to end. `npm test` -> 128 tests, 127 pass, 0 fail, 1 todo
(the Phoenix divergence below), re-checked 2026-09-11. Run the root script, not
`npm test --workspaces`: `apps/web` has no test script, so the bare form exits 1
on that alone. `npm run e2e` runs a real browser-less client against a real
server, which has to be up already (`127.0.0.1:3999`, overridable with
`FR_E2E_BASE`); it also passes against the Docker image, and a game in progress
survives `docker restart`.

Layout:

    packages/shared     protocol + domain types (the contract)
    packages/engine     node:vm-per-room wrapper + vendor/ (never edited)
    packages/carddata   generated card data + 14 locales of text
    apps/server         game state machine, rooms, ws, SQLite
    apps/web            Vite + React client
    scripts/            sync-engine, extract-cards, sync-i18n, sync-colours,
                        compute-harm, gen-upstream-tests, e2e-smoke,
                        e2e-fullgame, companion-player

`npm run sync` re-derives everything from the pinned submodule: vendored engine,
card data, translations, and the ported test suite.

Measured: a room costs ~1ms and ~0.2MB, so 50 concurrent rooms is ~11MB. Note the
heap does not drop immediately after `dispose()`, since V8 does not reclaim vm
contexts eagerly. Not a problem at this scale, but it is not zero either.

### Known gaps

Real and deliberate, not oversights:

- **App chrome is German and English only**, while card text ships in all 14
  languages. The interface strings live in `apps/web/src/ui-strings.ts` rather
  than in upstream's `.properties` files: upstream is a score calculator and has
  no words for turns, rooms or reveals. Adding a third interface language means
  adding a block there. The language can be changed at any point in a game and
  drives `<html lang>`.
- **Card art.** Styled components only, as planned. `FR01.jpg` / `CH20.jpg` scans
  drop in later behind an optional field.
- **Cursed Items are dealt one per player** from their own deck into a separate
  zone (they do not count against the hand limit). Worth confirming against the
  physical rules: this is the one expansion rule inferred rather than read.
- **Italian has no Cursed Hoard at all** (55 of 103 cards). Missing text falls
  back to English per card, marked with a small "EN" badge. Upstream's data, not
  ours. German's one hole was the Phoenix, which is no longer dealt, so German
  now plays with no fallback text anywhere.


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

The feel is modelled on moving something around on iOS: a card resists until it
is either held for ~190ms or moved ~16px, then breaks loose.

After that it is springs, not tweens. Position, lift and the flight home are
each a damped spring integrated against real elapsed time, in sub-steps of
1/240s so a long frame cannot make one explode. Damping is written as a fraction
of critical: 0.7 while following, and on the flight home it depends on how hard
the card was thrown, exactly critical when it is set down gently and 0.7 at
2600px/s, so an ordinary drag simply arrives and a throw goes a little past its
place and comes back. Both settle in about 150ms with an overshoot too small to
read as a bounce: snappy rather than springy. The earlier "move 26% of the
remaining distance each frame" was neither, and it settled twice as fast on a
120Hz screen as on a 60Hz one.

The spring aims at the pointer with the card centred on it, so breaking loose
also gathers the card under the hand that picked it up. It is the resulting lag
that produces the rest of the feel for free: the card trails a fast hand, and
its tilt is that lag, up to 9 degrees at 100px behind, straight again at rest.

**Taking a card into the hand.** A card dragged in from the draw pile or the
discard area goes where it is dropped, so the `draw` message carries an `index`.
Without it the server appended, and no amount of animation could hide that the
card had landed somewhere else than where it was let go. Omitting the index
still means the end of the hand, which is what Enter does. The index is
clamped and anything that is not a whole number in range is treated as
"no answer", because it arrives from a client.

The hand also opens a real place for it, an outline rather than a card, marked
as the gap the same way a rearrangement's faded card is. That is what gives an
arriving card something to snap to, and it means the place you can see is the
place the card will take. No place is offered for a draw that would be refused.

The hold itself is a detent: while a card sits in a gap it is pulled back
towards it at 68% strength, giving out only once the pointer is 0.6 of a cell
away, which is the distance the gap moves along by. So a card clings to the row,
strains, and drops into the next place rather than sliding continuously through
positions it was never really in. The hold fades out with how fast the pointer
is moving: fully there below 260px/s, gone above 1100px/s. Detents are for
putting a card down deliberately, and a throw starts inside the hand, so without
this a fling was caught by every cell it crossed on the way out. The speed measured is the pointer's, not the
card's, since the card is the thing being held back.

**The magnet.** While a card is over somewhere it could land, its target is
blended towards the exact place it would occupy, by up to 55%, ramped with a
smoothstep so the pull has no edge to it. Reach is a multiple of the card's own
width rather than a number of pixels, so it scales with the layout: 1.5x for a
gap in the hand, which is under the pointer anyway and only wants a nudge, and
2.5x for the discard area, which is one destination for a whole corner of the
table. The place itself is measured off the live layout rather than calculated:
in the hand it is literally the faded card sitting in the previewed order, so
the magnet cannot disagree with what the row is showing.

**Letting go.** The move is reported to the server immediately; waiting on an
animation for it is what makes an interface feel slow. The ghost then flies to
where the card actually went and fades out onto it over ~220ms, and the card it
came from stays faded for that long so the two cross over rather than both being
visible at once. A refused drop flies back to where it was picked up instead.

**Making room.** The hand is a grid, so React rearranging it moves every card
between cells in one paint and no CSS transition can catch that. `flip.ts`
measures each card before and after and animates the difference away (the FLIP
technique), with Web Animations rather than transitions so it starts reliably
without a forced reflow.

The slide is a spring like everything else in the drag, sampled into keyframes
at 10ms and handed over as a linear animation, because the timing is in the
samples. Two beziers were tried first and both were wrong: front loaded, the row
snapped shut and crept the rest of the way; eased at both ends, it was simply
slow. The spring is 93% of the way there by 80ms, tips about 5% past and settles
by 280ms. The overshoot being a proportion means a card moving one place tips
past it by a few pixels and one crossing the whole hand by more, which is what
gives a big rearrangement some weight.

Three details matter:

- A card already in flight is measured for how far it has been carried, and that
  is added back in, otherwise every crossing compounds the error until the row
  is millions of pixels off screen.
- Everything that hit tests the row asks `layoutBox()` rather than
  `getBoundingClientRect()`, so it sees the cells and not the slide in progress.
  Deciding the arrangement from drawn positions feeds the row's own animation
  back into its answer: wiggle a card across a boundary and the same pointer
  position lands in different cells depending on how far the neighbours happen
  to have slid, which reads as the row giving up on following you.
- The card being dragged is left out of the sliding entirely, since the ghost is
  what moves and its gap has to hold still.

Only a hand slot is ever marked as the gap. A card being dragged out of the
discard area is faded in the same way, but that is where it came *from*; marking
it too meant the engine found that one first and pulled the card back towards
the place it was being taken from.

Under `prefers-reduced-motion` the card is simply placed at the pointer, with no
spring, tilt, lift, flight home, or sliding neighbours.

Note this replaces the old confirm-before-discard step: the drag gesture is
deliberate enough on its own, and a confirmation bar in the middle of a drag
would break the flow.

The reveal runs **one player at a time, in seat order**; everyone watches the
same card. Per card the server rescores the prefix that is face up, because
Fantasy Realms scoring is not additive: a later card can blank or rescue earlier
ones. The client animates the difference: a blanked card turns red (background
and border both) with a line struck through it, a floating "frei!" when one is
rescued,
and +/- badges on the cards that changed. The running total sits in the middle
at the top.

### Layout

Hands are laid out as a grid of **eight fixed columns**, not a wrapping flex
row. Eight is the largest a hand ever gets (Necromancer, or mid-turn before
discarding), so drawing a card never resizes or rewraps the row: the cards
simply are one eighth wide, before and after. The reveal row uses the same grid,
so a hand reads identically while playing and while being scored.

The discard area shows **all ten places it can hold** as two rows of five, empty
ones as dashed outlines, so how close the game is to ending is visible without
reading a counter. Those cards are full size with their rules text, exactly like
a card in hand: one `--card-w` drives the whole table, clamped for small screens,
and every grid is laid out in multiples of it. Eight fit across a hand, five
across a discard row.

The **draw pile occupies the first of those ten places** rather than sitting off
to one side. Nothing is lost by taking it: `discard()` ends the game the moment
the tenth card lands, so a tenth face-up card is never on the table to be looked
at, which leaves nine places for discards and one for the pile they come from.
Putting the two together also means the whole exchange happens inside one block
instead of across a gap, and the pile is the same size as every other card.

Cards have a **hardcoded 5:7 aspect ratio** so a long rules text can never
stretch one into a tall column. The width is deliberately generous (up to
9.2rem, ~141px at desktop width) to fit more text per line; the page is allowed
to grow to 1420px so eight of them still sit in one row. Text that would not fit is handled by stepping
the type down (two thresholds, by character count) rather than by clipping, and
Space opens the card in full. Whatever still overflows is simply cut off: the
bottom of the body used to fade under a mask, but that dimmed the last lines of
every card whether anything was being cut or not, and at the two smaller sizes
almost nothing is (five of 102 cards run past 210 characters in German, Lantern
worst at 324). Removed by owner decision (2026-09-10).

Hovering used to drop the ratio and let the card grow over its neighbours to
show that tail. It does not any more: a hand is a row of identical rectangles,
and one of them changing size reads as a new card arriving rather than as the
same card being pointed at. Nothing on the table moves or resizes on hover.

### Hovering a card

Hovering links a card to the rest of the table **in both directions**:

- conditions on other cards that refer to the hovered one light up (by suit, or
  by name in the current language);
- and the other way round: hovering "+20 for each Army" lights up the word
  ARMY on every Army card, and naming a specific card lights up that card's name.

The hovered card is **excluded from the first direction**, on itself only. A
Flame reading "for each other Flame" was lighting up the word FLAME in its own
text, one line under its own suit chip, which says nothing: the whole point of
the highlight is to point somewhere else. Its chip still pulses, so it stays
clear which card is being asked about.

The hovered card is also ringed in **its own suit colour** (`--suit-*-ink`, the
same value its top border already carries) rather than the app accent. Not
`--suit-*-hot`: that variant exists so a lit word can beat the resting text
around it, and on a ring it only read as too bright and slightly off the card's
own colour. Blue said only
"selected"; the suit colour says the same thing every highlight around it says,
in the same vocabulary. Each `.suit-border-*` rule publishes `--suit-ink` and
`--suit-hot` as variables, so anything on a card can ask for "my own colour"
without knowing which suit it is.

Cards the hovered one **blanks** are tinted with T3 Code's destructive colour
instead. Which those are is not read from the text: `scripts/compute-harm.mjs`
scores every pair against the real engine (B alone, then A and B together) and
records A as harming B when B comes out blanked next to A.

Text cannot answer this. Blizzard's "BLANKS all Floods" means every Flood is
hurt, but Wildfire's "BLANKS all cards EXCEPT Flames, Wizards, Weather, Weapons"
names the survivors; the tokens look identical and a text rule marks exactly the
wrong cards.

Only blanking counts, deliberately. Comparing points was too broad: Forge is a
Flame, so Blizzard's own "-5 for each Flame" makes Blizzard worth less beside
it, but that damage comes from Blizzard's rules, not Forge's, and lighting up
Blizzard while hovering Forge points the wrong way. 19 cards blank something,
165 relationships, computed in well under a second.

There is exactly **one** red in the app: T3 Code's `--error`. A card blanked by
the server right now, a card the hovered one would blank, the strike-through and
its label all resolve to the same value; the difference between them is what
you did to see it, not what it means. Negative point figures use it too, so no
second rose-coloured near-miss exists anywhere.

### Blanked cards, live

A card that is dead *right now* glows red and is struck through permanently, not
only on hover. The server asks the engine on every update and sends the blanked
ids alongside the private `hand` message, so it never reaches anyone else. Same
treatment during play and during the reveal.

The red has one job at a time. Hovering a card that blanks things (Blizzard,
Great Flood, the nineteen in `harm.json`) hands the red over to exactly the cards
that one kills, and every other card gives it up for as long as the hover lasts,
including cards that are themselves dead. Two sets of red at once would be two
different claims in the same colour. Those cards keep their line through them at
a third of the opacity, so the fact is still on screen; taking it away would say
they had come back to life. `.card-blanked` is therefore the dead treatment and
`.card-alarm` is the red, and only the second one moves around.

This goes through `RoomEngine.blankedIn()`, not `score()`. Between drawing and
discarding a player holds **eight** cards, and `score()` refuses that hand:
upstream's `addCard()` silently drops the eighth, and our bridge turns that into
a loud `HAND_REJECTED` rather than a quietly wrong total. The old code caught
that and reported nothing blanked, so the hint went dark for the entire turn in
which it decides the discard, which is the only turn it matters.

Blanking is a per-card rule ("BLANKS all Armies") that says nothing about how
many cards are held; only the hand limit does. `blankedIn()` therefore lifts the
size gate for the duration of one call, by shadowing `_canAdd` with an own
property on the hand instance and deleting it again in a `finally`. The vendored
files are untouched, `score()` keeps its strict contract, and `blankedIn()`
never returns a number: totals still come from the seven-card path only. A
player who drops mid-turn holding eight is still *scored* on their best legal
seven (see "Vote to end early"); that is a different question from what is dead
on the table in front of them.

The lookup goes through `#engineFor()`, which builds the room's vm context on
demand. A room restored from SQLite after a restart starts with `engine: null`,
so reading the field directly meant a resumed game came back with nothing marked
until the next draw or discard happened to build one. The empty-hand check still
comes first, so a room sitting in the lobby never spins up a context.

Both directions read `relatedSuits` / `relatedCards` from the card data rather
than trusting the colours in the text, because a card named in someone's rules
text is painted in *its own* suit colour. Cavern's "+25 with Dwarvish Infantry or
Dragon" paints Dwarvish Infantry as an Army, so a naive suit comparison lit it up
whenever any Army was hovered, even though Cavern means that one card. Names
called out by a card are collected per card and matched by name only; everything
else is treated as a category.

That only works if `relatedCards` is complete, and upstream has one card where
it is not. Whirlwind's "+40 with Rainstorm and either Blizzard or Great Flood"
lists Blizzard and Great Flood in `relatedCards` but files **Rainstorm in
`relatedSuits`**. Read literally that claims a suit called Rainstorm, so the
word fell through to the category branch and, being painted Weather, lit up
whenever any Weather card was hovered: hovering Blizzard highlighted Rainstorm
on Whirlwind too. `scripts/extract-cards.mjs` now moves any `relatedSuits` entry
that is not a suit but is a card name into `relatedCards`, and fails the build
on anything that is neither. Both directions are fixed by the one move, and the
calculator submodule stays untouched. It is the only such entry in all 103
cards, and no card name collides with a suit label.

The hovered card is matched against itself as well, so "+15 for each other Land"
lights up LAND on the card saying it, not only on the other Lands.

Cards are plain elements, not buttons. They are dragged rather than pressed, and
rendering them as disabled buttons left the whole table looking greyed out and
inert.

The background image is wider than the element, so it is set to `no-repeat`:
with the default tiling the band reappeared a second time near the end of every
pass.

A shimmer runs **continuously** while the card is hovered: a band of light
travels across the text on a 1.5s loop.

The gradient's base is the **resting** colour, not the lit one. With the bright
colour as the base the whole text jumped brighter the instant the sweep started
and dropped back when it ended; now only the travelling band is brighter, so
switching the effect on and off is invisible and the light is the only thing that
moves. The band eases through `--suit-*-hot` into white, which is what that third
brightness (generated by `scripts/sync-colours.mjs`) is for.

The suit chip is white on a filled colour, where there is nothing brighter than
white to sweep with and tinting the text would only darken it. It pulses its ring
instead, on the same 1.5s beat so it stays in step.

Ending the hover does not cut the animation off. `useSweep` keeps it running and
clears it on the next `animationiteration`, so the pass in flight always
completes and the text settles at a whole cycle rather than snapping back
mid-band. `animationiteration` bubbles, so one handler on the card body covers
every highlighted reference in it, so they start together and stay in step. The
last match is held alive for that tail, otherwise there would be nothing left to
light while it finishes.

This is a mouse affordance; touch devices have no hover, and the drag gesture is
what carries there. `prefers-reduced-motion` drops the sweep.

The draw pile is unlabelled: a face-down card is self-explanatory, and the count
sits quietly in its corner rather than filling the card.

Below 900px the grids drop to four and five columns.

### UI colours

The chrome (background, panels, borders, accent) comes from T3 Code's own
stylesheet, read from source rather than guessed:
`github.com/pingdotgg/t3code` @ `eb11506`, `apps/web/src/index.css`, dark theme.

| ours | theirs | value |
| --- | --- | --- |
| `--bg` | `--background` | `oklch(14.5% 0 0)` (neutral-950) |
| `--ink` | `--foreground` | `oklch(97% 0 0)` (neutral-100) |
| `--panel` | `--card` | background 97% + white |
| `--muted` | `--muted-foreground` | neutral-500 90% + white |
| `--line` | `--border` | white 6% |
| `--input-line` | `--input` | white 8% |
| `--accent` | `--primary` | `oklch(0.571 0.21 264)` |
| `--danger` | `--error` | red-500 90% + white |
| `--radius` | `--radius` | `0.625rem` |

Written in the same notation rather than converted, so they are the identical
colours. Note this is T3 *Code*, neutral grey with a blue accent, and not
t3.chat, which is pink and a different product.

Places that previously mixed the old gold accent by hand now derive their tints
from `--accent` with `color-mix`, so changing the accent changes them all.

### Suit colours

The palette is not ours: `scripts/sync-colours.mjs` reads `--land-color`,
`--flame-color` and the rest straight out of `calculator/css/style.css` and
writes `apps/web/src/suits.css`, so a submodule update carries the colours over.

Upstream paints suits as backgrounds on light cards, so several are very dark
(`--army-color #312b2f`, `--land-color #3b1d13`) and would vanish as text on our
dark background. Each colour therefore gets a second `--suit-*-ink` variant:
the same colour raised in lightness, a step at a time, only until it clears WCAG
AA (4.5:1) against the background (`#0f0f0f`, derived from T3 Code's). Six of
the fifteen already pass and are left untouched.

The lightening happens **in OKLCH**, moving L while hue and chroma stay put.
Mixing in white is easier arithmetic and was what this did first, but white
mixing pulls everything towards grey: Land's brown came out taupe (`#897771`)
and Army came out a flat neutral (`#7f7c7e`), so a card no longer read as the
calculator's colour at all. In OKLCH the same two land on `#987367` and
`#80797d`, and chroma is only given up where the lighter colour would fall
outside sRGB.

Filled elements (the suit chip on a card) use the exact upstream colour.
Text and borders use the ink variant. Same hue either way.

Cards the newest one interacts with light up **in that card's own suit colour**:
a Flame lights its targets in red, a Leader in gold. Relevance comes from
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


## The frame around the game (2026-09-08)

Everything below came out of playing the built game and writing down what was
missing. None of it changes the rules or the scoring.

**One bar, always there.** Room code, invite, language and the way out used to
exist only on the home screen and in the lobby, and vanished the moment a game
started. They now sit in an `AppBar` rendered above every phase.

**The code is the invite.** Pressing it copies `?room=CODE`, which prefills the
code for whoever follows the link, so the button they land on already says
"Beitreten". `share.ts` falls back to the old selection-based copy: the clipboard
API needs a secure context and this is meant to be reachable over plain HTTP on a
LAN as well as through a proxy with TLS.

**Cards are operable without a pointer.** During play there used to be zero
focusable elements in `<main>`; dragging was the only way to do anything at
all. Cards are now `role="button"`, focusable and labelled ("Rauch, Stärke 27,
Wetter, blockiert"). Enter draws or discards, Alt+←/→ sorts the hand, Space
opens the card full size. Focus lights up the same relationships that hovering
does, so the highlighting is not mouse-only.

Drag stays the way you *play* a card, as agreed. The keyboard is a second route,
not a replacement, and legality is now decided on release rather than by refusing
to pick a card up, so a card can be examined even when the move is not yours.

**Long rules text has a way out.** A fixed aspect ratio clips Jewel of Order and
the Phoenix; on a mouse that was covered by growing the card on hover, which does
not exist on touch and cannot be reached from a keyboard. A tap (a press that
never breaks loose into a drag) or Space opens `CardOverlay`: same card, no
ratio, no clipping.

**Whose turn it is, in words.** A blue ring around a name chip was the only
signal, and it never said *who*. There is now a banner, "Freund ist am Zug",
in an `aria-live` region.

**Rematch instead of reload.** "Neues Spiel" on the scoreboard called
`location.reload()`, which dropped everyone back to the home screen to retype the
code. `resetToLobby()` puts the same room back in the lobby with seats kept. It
drops players who are no longer connected: holding a seat for someone who closed
the tab on the scoreboard would deal them a hand and then stall the new game on
their turn until the disconnect vote opened.

**The scoreboard leads with the result.** Ranking with bars and the gap to the
winner first; the per-card table is evidence behind a `<details>`.

Smaller: the board is centred rather than left-aligned (the grids keep their
fixed column counts so a hand never rewraps between seven and eight cards, and
are centred as blocks); the ten empty discard places are drawn quietly and
labelled "Ablage 7/10"; the lobby checkboxes are themed instead of being the one
white system control on a near-black page; the home screen says what the game is
in three lines.

**Not done, deliberately:** the phone layout. Below 900px the discard row still
forces five columns while the hand drops to four, so the page scrolls sideways
(573px of content in a 390px viewport). Parked.

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
`PHOENIX_PROMO` explicitly in `blanks()`, a code path that never consults
`penaltyCleared`. The two cards are meant to be the same card.

**Open question for whoever owns the physical cards**: does Beastmaster's
"CLEARS the Penalty on all Beasts" cancel Phoenix's "BLANKED if you have any
Flood"? Until answered, we ship upstream's behaviour unmodified, which means
FR55 and FR55P disagree in this one exotic hand.

Since both Phoenixes were dropped (the promo 2026-09-08, `FR55` itself
2026-09-11) the disagreement cannot reach a real game: neither card is ever
dealt, so no table ever scores one. The vector stays `it.todo` because it is
upstream's own expectation, it is still run against the engine, and we still do
not match it. The open question above is therefore no longer blocking anything;
it only decides whether `FR55` could ever come back.

## Working agreement

If a better solution turns up while building, or something specced here stops
making sense once it meets real code, **ask before diverging.** Don't silently
implement something different, and don't grimly implement something that has
become wrong. Raise it, get a decision, and update this document.
