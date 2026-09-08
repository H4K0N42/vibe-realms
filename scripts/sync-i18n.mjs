// Converts the pinned submodule's Java .properties translations into typed JSON,
// one file per locale, and parses card effect text out of HTML into TextToken[].
//
// Upstream renders that text as raw HTML with its own CSS. We render it with our
// own components, so no HTML may survive into the output -- see DESIGN.md "i18n".
//
// The upstream data is hand-maintained across 14 languages and is dirty in
// well-defined ways (wrong-case suit classes, a stray space, two malformed tags).
// Known dirt is normalised; anything else is reported loudly rather than silently
// turning into plain text.
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const I18N_DIR = join(root, 'calculator', 'i18n');
const OUT_DIR = join(root, 'packages', 'carddata', 'i18n');

const SUITS = new Set([
  'land', 'flood', 'weather', 'flame', 'army', 'wizard', 'leader', 'beast',
  'weapon', 'artifact', 'wild', 'building', 'outsider', 'undead', 'cursed-item',
]);

/** Java .properties: `=` or `:` separator, `#`/`!` comments, `\uXXXX` escapes. */
function parseProperties(text) {
  const out = new Map();
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    let line = lines[i];
    if (!line.trim() || /^\s*[#!]/.test(line)) continue;
    // Backslash-continuation: a line ending in an odd number of backslashes.
    while (/(^|[^\\])(\\\\)*\\$/.test(line) && i + 1 < lines.length) {
      line = line.slice(0, -1) + lines[++i].replace(/^\s+/, '');
    }
    const m = line.match(/^\s*([^=:\s]+)\s*[=:]\s*(.*)$/);
    if (!m) continue;
    const value = m[2]
      .replace(/\\u([0-9a-fA-F]{4})/g, (_, h) => String.fromCharCode(parseInt(h, 16)))
      .replace(/\\([nrt\\:=])/g, (_, c) => ({ n: '\n', r: '\r', t: '\t' })[c] ?? c);
    out.set(m[1], value);
  }
  return out;
}

/** Normalise upstream's known suit-class dirt. Returns null if unrecognisable. */
function normaliseSuit(raw) {
  const s = raw.toLowerCase().replace(/\s+/g, '');
  return SUITS.has(s) ? s : null;
}

const issues = [];

/** HTML effect text -> TextToken[]. */
function parseText(html, { locale, key }) {
  const tokens = [];
  let bold = 0;
  let suit = null;

  const push = (value) => {
    if (!value) return;
    const token = suit
      ? { kind: 'ref', value, suit }
      : { kind: 'text', value };
    if (bold > 0) token.bold = true;
    // Merge adjacent same-styled text runs.
    const prev = tokens[tokens.length - 1];
    if (prev && prev.kind === token.kind && prev.kind === 'text' && !!prev.bold === !!token.bold) {
      prev.value += value;
      return;
    }
    tokens.push(token);
  };

  const decode = (s) =>
    s.replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&')
     .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"');

  // Malformed in upstream (kr): `<span class="flame"번개</span>` -- the tag is
  // never closed. Repair it rather than swallowing the whole line as text.
  html = html.replace(/<span\s+class="([^"]*)"(?=[^>])/g, '<span class="$1">');
  // Malformed in upstream: `<span class class="leader">`.
  html = html.replace(/<span\s+class\s+class=/g, '<span class=');

  const re = /<\s*(\/?)\s*([a-zA-Z]+)([^>]*?)\/?\s*>/g;
  let last = 0;
  let m;
  while ((m = re.exec(html)) !== null) {
    push(decode(html.slice(last, m.index)));
    last = re.lastIndex;
    const [, closing, rawTag, attrs] = m;
    const tag = rawTag.toLowerCase();

    if (tag === 'br') {
      // `</br>` appears once upstream; treat it as a break either way.
      tokens.push({ kind: 'break' });
    } else if (tag === 'b' || tag === 'strong') {
      bold += closing ? -1 : 1;
      if (bold < 0) bold = 0;
    } else if (tag === 'span') {
      if (closing) {
        suit = null;
      } else {
        const cls = attrs.match(/class\s*=\s*"([^"]*)"/);
        if (!cls) {
          suit = null; // bare <span> -- 10 of these upstream, plain text
        } else {
          const norm = normaliseSuit(cls[1]);
          if (norm === null) {
            issues.push(`${locale} ${key}: unknown span class "${cls[1]}"`);
            suit = null;
          } else {
            if (norm !== cls[1]) issues.push(`${locale} ${key}: normalised class "${cls[1]}" -> "${norm}"`);
            suit = norm;
          }
        }
      }
    } else {
      issues.push(`${locale} ${key}: unexpected tag <${closing}${tag}>`);
    }
  }
  push(decode(html.slice(last)));

  const leftover = tokens.some((t) => t.kind !== 'break' && /<[^>]+>/.test(t.value));
  if (leftover) issues.push(`${locale} ${key}: HTML survived into output`);
  return tokens;
}

// ---------------------------------------------------------------------------

mkdirSync(OUT_DIR, { recursive: true });

const files = readdirSync(I18N_DIR).filter((f) => /^Messages(_[\w]+)?\.properties$/.test(f));
const cardIds = new Set(
  JSON.parse(readFileSync(join(root, 'packages', 'carddata', 'data', 'cards.json'), 'utf8')).map((c) => c.id),
);

const summary = [];
for (const file of files) {
  const locale = file === 'Messages.properties' ? 'en-default' : file.slice(9, -11);
  const props = parseProperties(readFileSync(join(I18N_DIR, file), 'utf8'));

  const cards = {};
  const ui = {};
  for (const [key, value] of props) {
    const cm = key.match(/^([A-Z]{2}\d{2}P?)\.(name|bonus|penalty|action|timing)$/);
    if (cm) {
      const [, id, field] = cm;
      cards[id] ??= {};
      cards[id][field] = field === 'name' || field === 'action' || field === 'timing'
        ? value
        : parseText(value, { locale, key });
    } else {
      ui[key] = value;
    }
  }

  const named = Object.values(cards).filter((c) => c.name).length;
  const missing = [...cardIds].filter((id) => !cards[id]?.name);
  summary.push({ locale, cards: Object.keys(cards).length, named, missing });

  writeFileSync(join(OUT_DIR, `${locale}.json`), JSON.stringify({ locale, ui, cards }, null, 0) + '\n');
}

console.log('locale        cards  named  missing');
for (const s of summary.sort((a, b) => a.locale.localeCompare(b.locale))) {
  const flag = s.missing.length === 0 ? '' : `  <- ${s.missing.slice(0, 6).join(',')}${s.missing.length > 6 ? '…' : ''}`;
  console.log(`${s.locale.padEnd(12)} ${String(s.cards).padStart(5)} ${String(s.named).padStart(6)} ${String(s.missing.length).padStart(8)}${flag}`);
}

// Coverage manifest: the client falls back to English per-key for gaps, and the
// UI can warn when a locale is materially incomplete (Italian has no Cursed Hoard).
writeFileSync(
  join(OUT_DIR, 'manifest.json'),
  JSON.stringify(
    {
      generatedFrom: 'calculator/i18n/Messages_*.properties',
      fallback: 'en',
      totalCards: cardIds.size,
      locales: Object.fromEntries(
        summary.map((s) => [s.locale, { named: s.named, missing: s.missing }]),
      ),
    },
    null,
    2,
  ) + '\n',
);

if (issues.length) {
  const counts = new Map();
  for (const i of issues) {
    const kind = i.replace(/^[\w-]+ /, '').replace(/^[A-Z]{2}\d{2}P?\.\w+: /, '');
    counts.set(kind, (counts.get(kind) ?? 0) + 1);
  }
  console.log(`\n${issues.length} data issues (normalised, not fatal):`);
  for (const [kind, n] of [...counts].sort((a, b) => b[1] - a[1])) console.log(`  ${n}x  ${kind}`);
}
