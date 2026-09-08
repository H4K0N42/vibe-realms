// Copies the upstream engine out of the pinned calculator/ submodule into
// packages/engine/vendor/, byte-for-byte. See DESIGN.md "Engine reuse".
//
// The files are NOT modified. They are loaded into a per-room node:vm context
// at runtime because they declare process-global singletons.
import { createHash } from 'node:crypto';
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const src = join(root, 'calculator', 'js');
const dest = join(root, 'packages', 'engine', 'vendor');

// Order matters: deck.js defines the card database and helpers that
// hand.js/discard.js close over. This is also the load order in tests.html.
const FILES = ['deck.js', 'discard.js', 'hand.js', 'combinatorics.js'];

mkdirSync(dest, { recursive: true });

const manifest = {};
for (const file of FILES) {
  const from = join(src, file);
  copyFileSync(from, join(dest, file));
  manifest[file] = createHash('sha256').update(readFileSync(from)).digest('hex').slice(0, 16);
  console.log(`  ${file}  ${manifest[file]}`);
}

writeFileSync(
  join(dest, 'MANIFEST.json'),
  JSON.stringify({ loadOrder: FILES, sha256: manifest, syncedAt: new Date().toISOString() }, null, 2) + '\n'
);
console.log(`\nSynced ${FILES.length} files -> packages/engine/vendor/`);
