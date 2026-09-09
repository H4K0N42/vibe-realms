// Pulls the suit colours out of the pinned calculator submodule so ours are
// literally the same palette, and derives a readable variant for our dark
// background. Regenerate with `npm run sync`.
//
// Upstream paints suits as backgrounds on light cards, so several are very dark
// (--army-color #312b2f, --land-color #3b1d13). On our background they would be
// invisible as text or borders, so each colour also gets an "ink" variant.
//
// The lightening happens in OKLCH, raising lightness while hue and chroma stay
// put. Mixing in white instead is easier arithmetic but pulls every colour
// towards grey: it turned Land's brown into taupe and Army into a flat grey,
// so the card no longer read as the calculator's colour at all. Chroma is only
// given up where the lighter colour would fall outside sRGB.
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const css = readFileSync(join(root, 'calculator', 'css', 'style.css'), 'utf8');

// T3 Code's dark --card: neutral-950 mixed 97% with white. Resolved to hex
// here so the contrast maths stays plain sRGB arithmetic.
const BACKGROUND = '#0f0f0f';
const AA = 4.5;
// How far the "hot" state closes the remaining gap to white. Same hue and
// chroma as the ink, only brighter.
const HOT = 0.42;
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

// --- sRGB <-> OKLab, Bjoern Ottosson's coefficients ------------------------
const toLinear = (c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const fromLinear = (c) => (c <= 0.0031308 ? c * 12.92 : 1.055 * c ** (1 / 2.4) - 0.055);

const rgbToLch = (rgb) => {
  const [r, g, b] = rgb.map((c) => toLinear(c / 255));
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  const L = 0.2104542553 * l + 0.7936177850 * m - 0.0040720468 * s;
  const A = 1.9779984951 * l - 2.4285922050 * m + 0.4505937099 * s;
  const B = 0.0259040371 * l + 0.7827717662 * m - 0.8086757660 * s;
  return [L, Math.hypot(A, B), Math.atan2(B, A)];
};
const lchToRgb = (L, C, h) => {
  const A = C * Math.cos(h);
  const B = C * Math.sin(h);
  const l = (L + 0.3963377774 * A + 0.2158037573 * B) ** 3;
  const m = (L - 0.1055613458 * A - 0.0638541728 * B) ** 3;
  const s = (L - 0.0894841775 * A - 1.2914855480 * B) ** 3;
  return [
    +4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.7076147010 * s,
  ].map((c) => fromLinear(c) * 255);
};

// Straight down the chroma axis until the colour fits in sRGB: the hue is what
// identifies the suit, so it is the last thing to give up.
const fit = (L, C, h) => {
  for (let i = 0; i <= 40; i++) {
    const rgb = lchToRgb(L, C * (1 - i / 40), h);
    if (rgb.every((c) => c >= -0.5 && c <= 255.5)) {
      return rgb.map((c) => Math.min(255, Math.max(0, c)));
    }
  }
  return lchToRgb(L, 0, h).map((c) => Math.min(255, Math.max(0, c)));
};

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
  const [L0, C, h] = rgbToLch(base);
  // Lowest lightness that clears AA; the exact colour wins when it already does.
  let inkL = L0;
  let ink = base;
  if (contrast(base, bg) < AA) {
    for (let L = L0; L <= 1.0001; L += 0.002) {
      const rgb = fit(L, C, h);
      if (contrast(rgb, bg) >= AA) { inkL = L; ink = rgb; break; }
      inkL = L;
      ink = rgb;
    }
  }
  const hot = fit(inkL + (1 - inkL) * HOT, C, h);
  lines.push(`  --suit-${suit}: ${found[suit]};`);
  inkLines.push(`  --suit-${suit}-ink: ${toHex(ink)};`);
  hotLines.push(`  --suit-${suit}-hot: ${toHex(hot)};`);
  const moved = inkL > L0 + 1e-9 ? `, L ${L0.toFixed(2)} -> ${inkL.toFixed(2)}` : ', unchanged';
  report.push(`  ${suit.padEnd(12)} ${found[suit]}  ->  ${toHex(ink)}  (${contrast(ink, bg).toFixed(1)}:1${moved})`);
}

writeFileSync(
  join(root, 'apps', 'web', 'src', 'suits.css'),
  `/* GENERATED from calculator/css/style.css. Do not edit by hand.
   Regenerate with: node scripts/sync-colours.mjs

   --suit-*      upstream's exact colour, for fills and borders
   --suit-*-ink  the same hue and chroma, lifted in OKLCH until it reads on
                 ${BACKGROUND} (WCAG AA)
   --suit-*-hot  brighter still: the lit state a hover highlight settles on */
:root {
${lines.join('\n')}

${inkLines.join('\n')}

${hotLines.join('\n')}
}
`,
);
console.log(`suit colours from calculator/css/style.css -> apps/web/src/suits.css\n${report.join('\n')}`);
