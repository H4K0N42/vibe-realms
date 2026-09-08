// Per-room wrapper around the vendored Fantasy Realms scoring engine.
//
// The four files in ../vendor are copied byte-for-byte from upstream and must
// never be edited (scripts/sync-engine.mjs re-syncs them from the pinned
// submodule). They are browser scripts built on process-global singletons:
//
//   deck.js     `var deck`     -- .cards is MUTATED IN PLACE by
//                                enableCursedHoardSuits(), which `delete`s the
//                                8 base cards Cursed Hoard replaces.
//   discard.js  `var discard`
//   hand.js     `var hand`
//
// `require()`ing them would give the whole server ONE game state: a single room
// enabling Cursed Hoard would delete FR03/FR06/FR08/FR25/FR28/FR48/FR51/FR52
// out from under every other live room. So each RoomEngine gets its own
// `node:vm` context. See DESIGN.md "Engine reuse".

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const VENDOR_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'vendor');

/**
 * vm.Script objects are compile-once / run-in-many-contexts. Parsing deck.js
 * (1579 lines) for every room would dominate construction cost, so the compiled
 * scripts are cached at module scope. This is safe: a Script holds no state, only
 * bytecode. The *state* it creates lives in whichever context you run it in.
 * @type {vm.Script[] | null}
 */
let compiledVendor = null;
/** @type {vm.Script | null} */
let compiledBridge = null;

/** Load order comes from vendor/MANIFEST.json, written by scripts/sync-engine.mjs. */
function loadVendorScripts() {
  if (compiledVendor) return compiledVendor;
  const manifest = JSON.parse(readFileSync(join(VENDOR_DIR, 'MANIFEST.json'), 'utf8'));
  compiledVendor = manifest.loadOrder.map(
    (file) =>
      new vm.Script(readFileSync(join(VENDOR_DIR, file), 'utf8'), {
        filename: `fr-vendor:${file}`,
      }),
  );
  return compiledVendor;
}

/**
 * Host <-> sandbox bridge. Runs *inside* the room's context, after the vendor
 * files, and is the only thing that touches the vendored globals.
 *
 * Everything crosses the boundary as a JSON string. That is deliberate: an
 * object created inside the vm keeps a reference to the vm's realm through its
 * prototype chain, so handing one to the server would pin the whole context in
 * memory and make dispose() a lie. Strings are realm-free.
 */
const BRIDGE_SOURCE = `
var __fr = {
  cardData: function (card) {
    var out = {
      id: card.id,
      name: card.name,
      suit: card.suit,
      strength: card.strength,
      action: card.action === true,
      cursedItem: card.cursedItem === true,
      extraCard: card.extraCard === true,
      hasBonus: card.bonus === true,
      hasPenalty: card.penalty === true,
      referencesPlayerCount: card.referencesPlayerCount === true,
      referencesDiscardArea: card.referencesDiscardArea === true,
      relatedSuits: (card.relatedSuits || []).slice(),
      relatedCards: (card.relatedCards || []).slice()
    };
    if (card.replaces !== undefined) { out.replaces = card.replaces; }
    if (card.timing !== undefined) { out.timing = card.timing; }
    return out;
  },

  listCards: function () {
    var out = [];
    for (var id in deck.cards) { out.push(__fr.cardData(deck.cards[id])); }
    for (var cid in deck.cursedItems) { out.push(__fr.cardData(deck.cursedItems[cid])); }
    return JSON.stringify(out);
  },

  // Which of the requested ids does this room's deck actually know about?
  // (After enableCursedHoardSuits() the 8 replaced base cards are gone.)
  unknownIds: function (json) {
    var ids = JSON.parse(json);
    var missing = [];
    for (var i = 0; i < ids.length; i++) {
      if (deck.getCardById(ids[i]) === undefined) { missing.push(ids[i]); }
    }
    return JSON.stringify(missing);
  },

  handLimit: function () {
    hand.clear();
    return hand.limit();
  },

  // Test-only: upstream's own suite expresses hands as codes
  // ("FR01,FR08+FR52:FR11"). Exposing loadFromString lets those 60+ vectors be
  // ported verbatim instead of hand-transcribed into arrays.
  scoreCode: function (code) {
    hand.clear();
    discard.clear();
    hand.loadFromString(code);
    return JSON.stringify({ total: hand.score(), cards: hand.cardNames() });
  },

  scoreNames: function (json) {
    var names = JSON.parse(json);
    hand.clear();
    discard.clear();
    for (var i = 0; i < names.length; i++) { hand.addCard(deck.getCardByName(names[i])); }
    return JSON.stringify({ total: hand.score(), cards: hand.cardNames() });
  },

  score: function (json) {
    var req = JSON.parse(json);

    hand.clear();
    discard.clear();
    hand.loadFromArrays(req.hand, req.actions);

    // addCard() silently returns false when the hand limit is exceeded, which
    // would otherwise produce a quietly wrong score. Fail loudly instead.
    var dropped = [];
    for (var i = 0; i < req.hand.length; i++) {
      if (hand.getCardById(req.hand[i]) === undefined) { dropped.push(req.hand[i]); }
    }
    if (dropped.length > 0) {
      return JSON.stringify({ error: 'HAND_REJECTED', dropped: dropped, limit: hand.limit() });
    }

    if (req.discard.length > 0) { discard.loadFromArray(req.discard); }

    var total = hand.score(discard);

    var breakdown = [];
    for (var j = 0; j < req.hand.length; j++) {
      var c = hand.getCardById(req.hand[j]);
      breakdown.push({
        cardId: c.id,
        base: c.strength,
        bonus: c.bonusPoints,
        penalty: c.penaltyPoints,
        blanked: c.blanked === true,
        points: c.points(),
        name: c.name,
        suit: c.suit
      });
    }

    return JSON.stringify({ total: total, breakdown: breakdown, code: hand.toString() });
  }
};
`;

function loadBridgeScript() {
  compiledBridge ??= new vm.Script(BRIDGE_SOURCE, { filename: 'fr-engine:bridge.js' });
  return compiledBridge;
}

const PHOENIX = 'FR55';
const PHOENIX_PROMO = 'FR55P';

/**
 * The 8 base cards Cursed Hoard's suit cards replace. Kept here only so the
 * isolation tests can assert against a literal list rather than re-deriving it
 * from the thing under test.
 */
export const CURSED_HOARD_REPLACES = Object.freeze([
  'FR03', 'FR06', 'FR08', 'FR25', 'FR28', 'FR48', 'FR51', 'FR52',
]);

export const MIN_PLAYERS = 2;
export const MAX_PLAYERS = 6;

/**
 * @typedef {object} RoomEngineOptions
 * @property {boolean} [cursedHoardSuits=false]
 * @property {boolean} [cursedHoardItems=false]
 * @property {boolean} [phoenixPromo=false]
 * @property {number}  [playerCount=4]
 */

export class RoomEngine {
  /** @type {vm.Context | null} */
  #context = null;
  /** @type {Record<string, unknown> | null} */
  #sandbox = null;
  /** @type {Readonly<Required<RoomEngineOptions>>} */
  #settings;

  /** @param {RoomEngineOptions} [opts] */
  constructor(opts = {}) {
    const {
      cursedHoardSuits = false,
      cursedHoardItems = false,
      phoenixPromo = false,
      playerCount = 4,
    } = opts;

    if (!Number.isInteger(playerCount) || playerCount < MIN_PLAYERS || playerCount > MAX_PLAYERS) {
      // CH24 Spyglass does `playerCount === 2` (strict), CH06 Genie does
      // `playerCount - 1`. Upstream reads this off a URL param / localStorage
      // and can end up with a string; we insist on a number.
      throw new RangeError(
        `playerCount must be an integer ${MIN_PLAYERS}-${MAX_PLAYERS}, got ${JSON.stringify(playerCount)}`,
      );
    }

    this.#settings = Object.freeze({ cursedHoardSuits, cursedHoardItems, phoenixPromo, playerCount });

    // These four are globals the vendored files read but never declare
    // (upstream declares them in app.js, which we do not vendor).
    this.#sandbox = {
      cursedHoardSuits,
      cursedHoardItems,
      playerCount,
      // deck.js:1533, getCardsBySuit() -- a display-sort helper the server never
      // calls. Stubbed only so the file evaluates.
      jQuery: { i18n: { prop: (key) => String(key) } },
    };

    this.#context = vm.createContext(this.#sandbox, {
      name: `fr-room(${cursedHoardSuits ? 'ch-suits ' : ''}${cursedHoardItems ? 'ch-items ' : ''}p${playerCount})`,
      codeGeneration: { strings: false, wasm: false },
    });

    for (const script of loadVendorScripts()) script.runInContext(this.#context);
    loadBridgeScript().runInContext(this.#context);

    // Expansion toggles are applied by calling the vendored functions inside
    // this room's own context, so the in-place mutation of deck.cards is
    // confined to this realm.
    if (cursedHoardSuits) this.#call('deck.enableCursedHoardSuits()');
    if (cursedHoardItems) this.#call('deck.enableCursedHoardItems()');
  }

  /** @param {string} source */
  #call(source) {
    if (this.#context === null) throw new Error('RoomEngine has been disposed');
    return vm.runInContext(source, this.#context, { filename: 'fr-engine:call.js' });
  }

  /** Room configuration this engine was built with. */
  get settings() {
    return this.#settings;
  }

  get disposed() {
    return this.#context === null;
  }

  /**
   * Cards in play for this room's configuration, including Cursed Items when
   * enabled. Base cards replaced by Cursed Hoard are absent; exactly one of
   * FR55 / FR55P is present depending on `phoenixPromo`.
   * @returns {import('./index.js').EngineCardDef[]}
   */
  listCards() {
    /** @type {import('./index.js').EngineCardDef[]} */
    const cards = JSON.parse(this.#call('__fr.listCards()'));
    const drop = this.#settings.phoenixPromo ? PHOENIX : PHOENIX_PROMO;
    return cards.filter((card) => card.id !== drop);
  }

  /**
   * @param {string} id
   * @returns {import('./index.js').EngineCardDef | undefined}
   */
  getCard(id) {
    return this.listCards().find((card) => card.id === id);
  }

  /** Maximum hand size for this room: 7, or 8 with Cursed Hoard suits. */
  get handLimit() {
    return Number(this.#call('__fr.handLimit()'));
  }

  /**
   * Score a hand.
   *
   * @param {string[]} handCardIds       Cards held, including any face-down Cursed Items.
   * @param {string[]} [discardCardIds]  Face-up discard area (several Cursed Hoard cards read it).
   * @param {Record<string, string | string[]>} [actionChoices]
   *   Player choices for cards with `action: true`, keyed by card id. A single
   *   choice may be given as a bare string. Book of Changes takes two:
   *   `{ FR49: ['FR47', 'Wizard'] }` (target card id, then suit).
   * @returns {import('./index.js').ScoreResult}
   */
  score(handCardIds, discardCardIds = [], actionChoices = {}) {
    if (!Array.isArray(handCardIds)) throw new TypeError('handCardIds must be an array');
    if (!Array.isArray(discardCardIds)) throw new TypeError('discardCardIds must be an array');

    const hand = handCardIds.map(normalizeId);
    const discardArea = discardCardIds.map(normalizeId);

    const duplicates = hand.filter((id, i) => hand.indexOf(id) !== i);
    if (duplicates.length > 0) {
      throw new Error(`duplicate cards in hand: ${duplicates.join(', ')}`);
    }
    const overlap = discardArea.filter((id) => hand.includes(id));
    if (overlap.length > 0) {
      throw new Error(`cards in both hand and discard area: ${overlap.join(', ')}`);
    }

    /** @type {string[][]} */
    const actions = [];
    for (const [cardId, choice] of Object.entries(actionChoices)) {
      if (choice === null || choice === undefined) continue;
      const id = normalizeId(cardId);
      if (!hand.includes(id)) {
        throw new Error(`action choice given for ${id}, which is not in the hand`);
      }
      const args = (Array.isArray(choice) ? choice : [choice]).map(String);
      if (args.length > 0) actions.push([id, ...args]);
    }

    const unknown = JSON.parse(
      this.#call(`__fr.unknownIds(${JSON.stringify(JSON.stringify([...hand, ...discardArea]))})`),
    );
    if (unknown.length > 0) {
      throw new Error(
        `unknown card id(s) for this room's configuration: ${unknown.join(', ')}` +
          (this.#settings.cursedHoardSuits
            ? ' (Cursed Hoard suits are enabled; the base cards it replaces are not in this deck)'
            : ''),
      );
    }

    const payload = JSON.stringify({ hand, discard: discardArea, actions });
    const result = JSON.parse(this.#call(`__fr.score(${JSON.stringify(payload)})`));

    if (result.error === 'HAND_REJECTED') {
      throw new Error(
        `hand rejected by the engine (limit ${result.limit}); dropped: ${result.dropped.join(', ')}`,
      );
    }
    return result;
  }

  /**
   * Score a hand written in upstream's code format, e.g.
   * `'FR03,FR17,FR32+FR49:FR47:Wizard'`. Exists so upstream's test vectors can
   * be run verbatim; the server uses score() instead.
   * @param {string} code
   * @returns {{ total: number, cards: string[] }}
   */
  scoreByCode(code) {
    return JSON.parse(this.#call(`__fr.scoreCode(${JSON.stringify(code)})`));
  }

  /**
   * Score a hand given card names. Upstream test vectors use this form too.
   * @param {string[]} names
   * @returns {{ total: number, cards: string[] }}
   */
  scoreByNames(names) {
    return JSON.parse(this.#call(`__fr.scoreNames(${JSON.stringify(JSON.stringify(names))})`));
  }

  /**
   * Drop the vm context. The engine is unusable afterwards; every other method
   * throws. Nothing this instance handed out holds a reference back into the
   * context (see BRIDGE_SOURCE), so the realm becomes collectable.
   */
  dispose() {
    if (this.#sandbox !== null) {
      // Break the biggest retainers explicitly rather than trusting one drop.
      for (const key of Object.keys(this.#sandbox)) {
        try {
          delete this.#sandbox[key];
        } catch {
          /* non-configurable globals; harmless */
        }
      }
    }
    this.#context = null;
    this.#sandbox = null;
  }
}

/**
 * Upstream accepts bare numbers ("3" / 3) and pads them to FR ids. Mirror that
 * so callers can use either, and so ported upstream test vectors work verbatim.
 * @param {string | number} id
 */
function normalizeId(id) {
  const s = typeof id === 'number' ? String(id) : id;
  if (typeof s !== 'string') throw new TypeError(`card id must be a string, got ${typeof id}`);
  return /^[0-9]+$/.test(s) ? `FR${s.padStart(2, '0')}` : s;
}
