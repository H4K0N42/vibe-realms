// Extracts STATIC STRUCTURAL card data out of the pinned calculator/ submodule
// into packages/carddata/data/cards.json.
//
// See DESIGN.md "Client / server split": card definitions are public rulebook
// data bundled into the client at build time.
//
// The data is *evaluated*, not parsed: calculator/js/deck.js is run in a
// node:vm sandbox and the resulting `base` / `cursedHoard` / `cursedItems`
// objects are read directly. That means a submodule bump re-derives the JSON
// instead of silently drifting from a hand-written transcription. The only
// browser dependency in deck.js is `jQuery.i18n.prop` (getCardsBySuit, ~line
// 1533), which is stubbed below.
//
// Scoring functions are deliberately NOT extracted. They stay in the vendored
// engine (packages/engine/vendor/) which runs in a per-room vm context.
//
// Run:  node scripts/extract-cards.mjs
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createContext, runInContext } from 'node:vm';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DECK_JS = join(ROOT, 'calculator', 'js', 'deck.js');
const SHARED_CARDS_TS = join(ROOT, 'packages', 'shared', 'src', 'cards.ts');
const OUT_DIR = join(ROOT, 'packages', 'carddata', 'data');

const fail = (msg) => {
  throw new Error(msg);
};

// --- packages/shared is the source of truth for the Suit union ------------
// Read the literal out of cards.ts rather than duplicating it here, so that a
// suit added upstream but not to the shared types fails this build loudly.
export function readSharedStringUnion(source, name) {
  const m = new RegExp(`export const ${name} = \\[([\\s\\S]*?)\\] as const;`).exec(source);
  if (!m) fail(`could not find \`export const ${name} = [...] as const;\` in ${SHARED_CARDS_TS}`);
  const values = m[1]
    .replace(/\/\/[^\n]*/g, '') // line comments, e.g. "// Cursed Hoard"
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => {
      const q = /^'([^']*)'$|^"([^"]*)"$/.exec(s);
      if (!q) fail(`unexpected entry in ${name}: ${s}`);
      return q[1] ?? q[2];
    });
  if (values.length === 0) fail(`${name} is empty`);
  return values;
}

// --- evaluate deck.js -----------------------------------------------------
export function loadDeck(deckJsPath) {
  const source = readFileSync(deckJsPath, 'utf8');
  const sandbox = {
    // deck.js:1533 sorts suits by their translated name for display. The
    // server never calls getCardsBySuit; the stub only has to exist.
    jQuery: { i18n: { prop: (key) => key } },
  };
  createContext(sandbox);
  runInContext(source, sandbox, { filename: 'deck.js' });
  for (const name of ['base', 'cursedHoard', 'cursedItems', 'ACTION_ORDER']) {
    if (!sandbox[name]) fail(`deck.js did not define \`${name}\` (did the upstream layout change?)`);
  }
  return { sandbox, sha256: createHash('sha256').update(source).digest('hex') };
}

const SETS = [
  ['base', 'base'],
  ['cursedHoard', 'cursed-hoard'],
  ['cursedItems', 'cursed-items'],
];

export function extractCards(sandbox, suits) {
  const suitSet = new Set(suits);
  const cards = [];
  const seen = new Set();

  for (const [globalName, set] of SETS) {
    for (const [id, raw] of Object.entries(sandbox[globalName])) {
      if (seen.has(id)) fail(`duplicate card id ${id} (second occurrence in ${globalName})`);
      seen.add(id);
      if (raw.id !== id) fail(`${globalName}.${id} has mismatched inner id ${JSON.stringify(raw.id)}`);
      if (!suitSet.has(raw.suit)) {
        fail(`${id}: suit ${JSON.stringify(raw.suit)} is not in the shared Suit union [${suits.join(', ')}]`);
      }
      if (typeof raw.strength !== 'number' || !Number.isFinite(raw.strength)) {
        fail(`${id}: strength is not a finite number (${raw.strength})`);
      }
      if (typeof raw.name !== 'string' || raw.name === '') fail(`${id}: missing name`);
      for (const flag of ['bonus', 'penalty', 'action']) {
        if (raw[flag] !== undefined && typeof raw[flag] !== 'boolean') {
          fail(`${id}: ${flag} should be boolean|undefined, got ${typeof raw[flag]}`);
        }
      }
      // Cross-check the declared flags against the actual scoring functions:
      // a card claiming a bonus with no bonusScore (or vice versa) is a bug.
      if (Boolean(raw.bonusScore) && !raw.bonus) fail(`${id}: has bonusScore() but bonus !== true`);
      if (Boolean(raw.penaltyScore) && !raw.penalty) fail(`${id}: has penaltyScore() but penalty !== true`);

      const card = {
        id,
        set,
        suit: raw.suit,
        // Upstream's English name. This is the engine's identity key:
        // hand.contains('Smoke') matches on name, not id. Display names come
        // from packages/carddata/data/text/<locale>.json.
        name: raw.name,
        strength: raw.strength,
        bonus: Boolean(raw.bonus),
        penalty: Boolean(raw.penalty),
        action: Boolean(raw.action),
        // What this card cares about. Upstream keeps these purely so its UI can
        // highlight connections; we use them the same way, to light up the
        // cards a freshly revealed one interacts with.
        // NOTE: relatedCards holds upstream's ENGLISH names, not ids; the
        // engine matches on name (hand.contains('Smoke')).
        relatedSuits: Array.isArray(raw.relatedSuits) ? [...raw.relatedSuits] : [],
        relatedCards: Array.isArray(raw.relatedCards) ? [...raw.relatedCards] : [],
      };
      if (raw.timing !== undefined) {
        if (typeof raw.timing !== 'string') fail(`${id}: timing is not a string`);
        card.timing = raw.timing;
      }
      if (raw.replaces !== undefined) {
        if (typeof raw.replaces !== 'string') fail(`${id}: replaces is not a string`);
        card.replaces = raw.replaces;
      }
      cards.push(card);
    }
  }

  // Upstream files one card name under relatedSuits: Whirlwind, whose "+40 with
  // Rainstorm and either Blizzard or Great Flood" puts Blizzard and Great Flood
  // in relatedCards but Rainstorm in relatedSuits. Read literally that says
  // "every card of the suit Rainstorm", and since the word is painted weather
  // in the rules text, hovering ANY Weather card lit up the word Rainstorm on
  // Whirlwind. Moving it to where it belongs fixes both directions at once, and
  // anything that is neither a suit nor a card name is a genuine surprise.
  const byName = new Set(cards.map((c) => c.name));
  for (const card of cards) {
    const misfiled = card.relatedSuits.filter((s) => !suits.includes(s));
    if (misfiled.length === 0) continue;
    const unknown = misfiled.filter((s) => !byName.has(s));
    if (unknown.length > 0) {
      fail(`${card.id}: relatedSuits has ${unknown.join(', ')}, neither a suit nor a card name`);
    }
    card.relatedSuits = card.relatedSuits.filter((s) => suits.includes(s));
    for (const name of misfiled) {
      if (!card.relatedCards.includes(name)) card.relatedCards.push(name);
    }
  }

  // `replaces` must name a base card that exists, because deck.js deletes it
  // from the live deck in enableCursedHoardSuits().
  const byId = new Map(cards.map((c) => [c.id, c]));
  for (const card of cards) {
    if (!card.replaces) continue;
    const target = byId.get(card.replaces);
    if (!target) fail(`${card.id}: replaces unknown card ${card.replaces}`);
    if (target.set !== 'base') fail(`${card.id}: replaces ${card.replaces}, which is not a base card`);
  }

  // The action flag must agree with the engine's ACTION_ORDER, which is what
  // actually sequences the player prompts (Doppelganger -> Mirage -> ...).
  const declared = cards.filter((c) => c.action).map((c) => c.id).sort();
  const ordered = [...sandbox.ACTION_ORDER].sort();
  if (declared.join(',') !== ordered.join(',')) {
    fail(`cards with action:true [${declared}] do not match ACTION_ORDER [${ordered}]`);
  }

  return cards;
}

function main() {
  const suits = readSharedStringUnion(readFileSync(SHARED_CARDS_TS, 'utf8'), 'SUITS');
  const { sandbox, sha256 } = loadDeck(DECK_JS);
  const cards = extractCards(sandbox, suits);

  mkdirSync(OUT_DIR, { recursive: true });
  writeFileSync(join(OUT_DIR, 'cards.json'), JSON.stringify(cards, null, 2) + '\n');
  writeFileSync(
    join(OUT_DIR, 'cards.provenance.json'),
    JSON.stringify(
      {
        note: 'Generated by scripts/extract-cards.mjs from the pinned calculator/ submodule. Do not edit by hand.',
        source: 'calculator/js/deck.js',
        sha256,
        cardCount: cards.length,
        bySet: Object.fromEntries(SETS.map(([, set]) => [set, cards.filter((c) => c.set === set).length])),
        actionOrder: sandbox.ACTION_ORDER,
      },
      null,
      2
    ) + '\n'
  );

  const counts = SETS.map(([, set]) => `${set}=${cards.filter((c) => c.set === set).length}`).join(' ');
  const replaces = cards.filter((c) => c.replaces);
  console.log(`cards.json: ${cards.length} cards (${counts})`);
  console.log(`  suits used: ${[...new Set(cards.map((c) => c.suit))].sort().join(', ')}`);
  console.log(`  action cards (${cards.filter((c) => c.action).length}): ${cards.filter((c) => c.action).map((c) => c.id).join(', ')}`);
  console.log(`  replaces (${replaces.length}): ${replaces.map((c) => `${c.id}->${c.replaces}`).join(', ')}`);
  console.log(`  deck.js sha256 ${sha256.slice(0, 16)}`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
