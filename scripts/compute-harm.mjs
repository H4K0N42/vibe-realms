// Works out, for every card, which other cards it damages, by asking the real
// scoring engine instead of reading the rules text.
//
// Text is not good enough for this. Blizzard's "BLANKS all Floods" means every
// Flood is hurt, but Wildfire's "BLANKS all cards EXCEPT Flames, Wizards,
// Weather, Weapons" names the exact opposite: the survivors. Nothing in the
// tokens distinguishes those two, and guessing gets it visibly wrong.
//
// Method: score B alone, then score A and B together, and record A as harming B
// when B ends up BLANKED by A's presence.
//
// Only blanking counts. Points alone was too broad: Forge is a Flame, and
// Blizzard's own "-5 for each Flame" makes Blizzard worth less next to it, but
// that damage comes from Blizzard's rules, not Forge's, so lighting up Blizzard
// when hovering Forge points the wrong way. In Fantasy Realms a card only ever
// reaches across and hurts another by blanking it.
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { RoomEngine } from '../packages/engine/src/index.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

/** @param {RoomEngine} engine */
function harmsFor(engine) {
  const ids = engine.listCards().filter((c) => !c.cursedItem).map((c) => c.id);
  // Some cards blank themselves in isolation (Smoke without a Flame); those are
  // not anybody else's doing.
  const blankAlone = new Set();
  for (const id of ids) {
    const r = engine.score([id]);
    if (r.breakdown[0]?.blanked) blankAlone.add(id);
  }

  const harms = new Map(ids.map((id) => [id, new Set()]));
  for (const a of ids) {
    for (const b of ids) {
      if (a === b) continue;
      let paired;
      try {
        paired = engine.score([a, b]);
      } catch {
        continue; // an illegal pairing tells us nothing
      }
      const row = paired.breakdown.find((r) => r.cardId === b);
      if (!row) continue;
      if (row.blanked && !blankAlone.has(b)) harms.get(a).add(b);
    }
  }
  return harms;
}

const merged = new Map();
for (const opts of [
  { playerCount: 4 },
  { cursedHoardSuits: true, cursedHoardItems: true, playerCount: 4 },
]) {
  const engine = new RoomEngine(opts);
  for (const [id, set] of harmsFor(engine)) {
    if (!merged.has(id)) merged.set(id, new Set());
    for (const victim of set) merged.get(id).add(victim);
  }
  engine.dispose();
}

const out = Object.fromEntries(
  [...merged].map(([id, set]) => [id, [...set].sort()]).filter(([, v]) => v.length > 0),
);
writeFileSync(join(root, 'packages/carddata/data/harm.json'), JSON.stringify(out, null, 0) + '\n');

const total = Object.values(out).reduce((n, v) => n + v.length, 0);
console.log(`cards that harm something: ${Object.keys(out).length}`);
console.log(`harm relationships: ${total}`);
for (const id of ['FR12', 'FR16', 'FR08']) {
  if (out[id]) console.log(`  ${id} harms ${out[id].length}: ${out[id].slice(0, 8).join(',')}${out[id].length > 8 ? '…' : ''}`);
}
