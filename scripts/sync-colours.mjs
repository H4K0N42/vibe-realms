// Pulls the suit colours out of the pinned calculator submodule so ours are
// literally the same palette, and derives a readable variant for our dark
// background. Regenerate with `npm run sync`.
//
// Upstream paints suits as backgrounds on light cards, so several are very dark
// (--army-color #312b2f, --land-color #3b1d13). On our background they would be
// invisible as text or borders, so each colour also gets an "ink" variant:
// white mixed in until it clears WCAG AA (4.5:1) against the app background.
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const css = readFileSync(join(root, 'calculator', 'css', 'style.css'), 'utf8');

// T3 Code's dark --card: neutral-950 mixed 97% with white. Resolved to hex
// here so the contrast maths stays plain sRGB arithmetic.
const BACKGROUND = '#0f0f0f';
const SUITS = [
  'land', 'flood', 'weather', 'flame', 'army', 'wizard', 'leader', 'beast',
  'weapon', 'artifact', 'wild', 'building', 'outsider', 'undead', 'cursed-item',
];

const hex = (h) => {
  const v = h.replace('#', '');
  const n = v.length === 3 ? v.split('').map((c) => c + c).join('') : v;
  return [0, 2, 4].map((i) => parseInt(n.slice(i, i + 2), 16));
};
const toHex = (rgb) => '#' + rgb.map((c) => Math.round(c).toString(16).padStart(2, '0')).join('');
const lum = (rgb) => {
  const [r, g, b] = rgb.map((c) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const contrast = (a, b) => {
  const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p);
  return (x + 0.05) / (y + 0.05);
};
const mixWhite = (rgb, k) => rgb.map((c) => c + (255 - c) * k);

const found = {};
for (const suit of SUITS) {
  const m = css.match(new RegExp(`--${suit}-color:\\s*(#[0-9a-fA-F]{3,6})`));
  if (!m) throw new Error(`no --${suit}-color in calculator/css/style.css`);
  found[suit] = m[1].toLowerCase();
}

const bg = hex(BACKGROUND);
const lines = [];
const inkLines = [];
const hotLines = [];
const report = [];
for (const suit of SUITS) {
  const base = hex(found[suit]);
  let k = 0;
  let ink = base;
  // Smallest amount of white that clears AA; exact colour wins when it already does.
  while (contrast(ink, bg) < 4.5 && k < 1) {
    k += 0.02;
    ink = mixWhite(base, k);
  }
  // "hot": the lit state a highlight settles on, and the colour the sweep
  // leaves behind it. Same hue, clearly brighter than the resting ink.
  const hot = mixWhite(ink, 0.42);
  lines.push(`  --suit-${suit}: ${found[suit]};`);
  inkLines.push(`  --suit-${suit}-ink: ${toHex(ink)};`);
  hotLines.push(`  --suit-${suit}-hot: ${toHex(hot)};`);
  report.push(`  ${suit.padEnd(12)} ${found[suit]}  ->  ${toHex(ink)}  (${contrast(ink, bg).toFixed(1)}:1${k ? `, +${Math.round(k * 100)}% white` : ', unchanged'})`);
}

writeFileSync(
  join(root, 'apps', 'web', 'src', 'suits.css'),
  `/* GENERATED from calculator/css/style.css -- do not edit by hand.
   Regenerate with: node scripts/sync-colours.mjs

   --suit-*      upstream's exact colour, for fills and borders
   --suit-*-ink  the same hue lightened until it reads on ${BACKGROUND} (WCAG AA)
   --suit-*-hot  brighter still: the lit state a hover highlight settles on */
:root {
${lines.join('\n')}

${inkLines.join('\n')}

${hotLines.join('\n')}
}
`,
);
console.log(`suit colours from calculator/css/style.css -> apps/web/src/suits.css\n${report.join('\n')}`);
