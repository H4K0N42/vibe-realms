// Regenerates packages/engine/test/upstream.test.js from the pinned submodule's
// own suite (calculator/js/tests.js), which is a browser page that renders <li>
// elements rather than failing a build. Extracting the vectors mechanically
// avoids transcription errors and keeps them honest across submodule updates.
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const src = readFileSync(join(root, 'calculator', 'js', 'tests.js'), 'utf8');

/**
 * Vectors that do not hold against the vendored engine at the pinned commit.
 * Emitted as `it.todo` so they are reported every run instead of quietly
 * deleted. Keyed by the upstream message. See DESIGN.md "Known divergences".
 */
const KNOWN_DIVERGENCES = new Map([
  [
    'Great Flood can still blank a Phoenix since it is a Flood',
    'Beastmaster (FR27) clearsPenalty on beasts, and hand.js:233 skips blankedIf ' +
      'when penaltyCleared is set, so FR55 survives the Flood (64, not 41). ' +
      'FR55P is blanked in the same hand because the Flood names PHOENIX_PROMO ' +
      'in blanks(), a path that ignores penaltyCleared. Upstream is inconsistent ' +
      'between the two Phoenix printings; awaiting a rules decision.',
  ],
]);

const [head, , tail] = src.split(/(deck\.enableCursedHoardSuits\(\);)/);

const RE =
  /assertScoreBy(Code|Name)\(\s*(\[[^\]]*\]|'[^']*')\s*,\s*(-?\d+)\s*(?:,\s*'((?:[^'\\]|\\.)*)')?\s*\)/g;

function vectors(block) {
  const out = [];
  for (const m of block.matchAll(RE)) {
    const [, kind, rawArg, score, msg] = m;
    const arg =
      kind === 'Name'
        ? rawArg.slice(1, -1).split(',').map((s) => s.trim().replace(/^'|'$/g, '')).filter(Boolean)
        : rawArg.slice(1, -1);
    out.push({ kind, arg, score: Number(score), msg: (msg ?? '').replace(/\\'/g, "'") });
  }
  return out;
}

function emit(vs) {
  return vs
    .map(({ kind, arg, score, msg }) => {
      const label = msg || (kind === 'Name' ? arg.join(', ') : arg);
      const call =
        kind === 'Name'
          ? `engine.scoreByNames(${JSON.stringify(arg)})`
          : `engine.scoreByCode(${JSON.stringify(arg)})`;
      const divergence = KNOWN_DIVERGENCES.get(msg);
      if (divergence) {
        return (
          `  // KNOWN DIVERGENCE: ${divergence.replace(/\s+/g, ' ')}\n` +
          `  it.todo(${JSON.stringify(label)}, () => {\n` +
          `    assert.equal(${call}.total, ${score});\n  });`
        );
      }
      return `  it(${JSON.stringify(label)}, () => {\n    assert.equal(${call}.total, ${score});\n  });`;
    })
    .join('\n');
}

const base = vectors(head);
const ch = vectors(tail);

writeFileSync(
  join(root, 'packages', 'engine', 'test', 'upstream.test.js'),
  `// GENERATED from calculator/js/tests.js. Do not edit by hand.
// Regenerate with: node scripts/gen-upstream-tests.mjs
//
// ${base.length + ch.length} vectors from upstream's own suite, run against RoomEngine.
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import { RoomEngine } from '../src/room-engine.js';

describe('upstream vectors: base game', () => {
  /** @type {RoomEngine} */
  let engine;
  before(() => { engine = new RoomEngine({ playerCount: 4 }); });
  after(() => engine.dispose());

${emit(base)}
});

describe('upstream vectors: Cursed Hoard suits + Phoenix', () => {
  /** @type {RoomEngine} */
  let engine;
  before(() => { engine = new RoomEngine({ cursedHoardSuits: true, playerCount: 4 }); });
  after(() => engine.dispose());

${emit(ch)}
});
`,
);
console.log(`base=${base.length} cursedHoard=${ch.length} total=${base.length + ch.length} todo=${KNOWN_DIVERGENCES.size}`);
