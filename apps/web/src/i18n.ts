import { useEffect, useState } from 'react';

import type { CardId, CardText, TextToken } from '@fr/shared';
import manifest from '@fr/carddata/i18n/manifest';

import { LOCALE_LOADERS, type LocaleFile } from './locales.ts';

/** Locales we advertise in the picker. Everything else exists but is incomplete. */
export const PRIMARY_LOCALES = ['de', 'en'] as const;

export interface Dictionary {
  locale: string;
  ui(key: string, fallback?: string): string;
  card(id: CardId): CardText;
  /** True when this locale is missing text for the card and English is standing in. */
  isFallback(id: CardId): boolean;
}

const cache = new Map<string, LocaleFile>();

async function load(locale: string): Promise<LocaleFile> {
  const cached = cache.get(locale);
  if (cached) return cached;
  const loader = LOCALE_LOADERS[locale] ?? LOCALE_LOADERS['en']!;
  const mod = await loader();
  const file = (mod as { default: LocaleFile }).default ?? (mod as unknown as LocaleFile);
  cache.set(locale, file);
  return file;
}

/**
 * Upstream's translations are uneven: German is missing the Phoenix, Italian has
 * no Cursed Hoard at all. Anything absent falls back to English per key rather
 * than showing a blank card.
 */
export function useDictionary(locale: string): Dictionary | null {
  const [dict, setDict] = useState<Dictionary | null>(null);

  useEffect(() => {
    let alive = true;
    void (async () => {
      const [primary, english] = await Promise.all([load(locale), load('en')]);
      if (!alive) return;
      setDict({
        locale,
        ui: (key, fallback) => primary.ui[key] ?? english.ui[key] ?? fallback ?? key,
        card: (id) => {
          const own = primary.cards[id];
          const en = english.cards[id];
          const source = own?.name ? own : (en ?? own ?? {});
          return {
            name: source.name ?? id,
            bonus: source.bonus as TextToken[] | undefined,
            penalty: source.penalty as TextToken[] | undefined,
            action: source.action,
          };
        },
        isFallback: (id) => !primary.cards[id]?.name,
      });
    })();
    return () => { alive = false; };
  }, [locale]);

  return dict;
}

export const localeCoverage = manifest as {
  totalCards: number;
  fallback: string;
  locales: Record<string, { named: number; missing: string[] }>;
};
