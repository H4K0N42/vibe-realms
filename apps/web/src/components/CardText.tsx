import { useEffect, useRef, useState } from 'react';

import type { TextToken } from '@fr/shared';

/** How the hovered card relates to every other card, in both directions. */
export interface TextMatch {
  /** The hovered card itself, so it can be left out of its own highlighting. */
  id: string;
  suit: string;
  /** Display name in the current locale, as it appears inside other cards. */
  name: string;
  /**
   * Suits the hovered card refers to as a *category* ("+20 for each Army").
   * Taken from upstream's relatedSuits, not from the colour of a word: naming
   * one Land card must not light up every Land.
   */
  refSuits: Set<string>;
  /** Cards it names, by upstream's English name (the engine's identity key). */
  refCardNames: Set<string>;
  /** Card ids this card damages, per the engine (see cards.ts). */
  harms: Set<string>;
}

/**
 * @param namedCards display names this card's text mentions as specific cards.
 *   A named card is painted in its own suit colour (Cavern's "Dwarvish
 *   Infantry" is drawn as an Army), so without this, hovering any Army would
 *   light it up, even though Cavern means that one card and nothing else.
 */
export function matches(
  token: TextToken,
  match: TextMatch | null,
  namedCards?: ReadonlySet<string>,
): boolean {
  if (!match || token.kind !== 'ref') return false;
  if (namedCards?.has(token.value)) return token.value === match.name;
  return token.suit === match.suit || token.value === match.name;
}

/**
 * The shimmer runs continuously while the card is hovered. When the hover ends
 * it is not cut off mid-sweep: `finishing` keeps it running until the animation
 * reaches the end of its current pass, at which point `settle()` clears it.
 */
export function useSweep(active: boolean) {
  const [finishing, setFinishing] = useState(false);
  const previous = useRef(active);

  useEffect(() => {
    if (previous.current && !active) setFinishing(true);
    if (active) setFinishing(false);
    previous.current = active;
  }, [active]);

  return {
    sweeping: active || finishing,
    /** Call on animationiteration: ends the sweep on a whole pass. */
    settle: () => {
      if (!active) setFinishing(false);
    },
  };
}

interface Props {
  tokens: TextToken[] | undefined;
  /** When set, references to this card are highlighted. */
  match?: TextMatch | null;
  sweeping?: boolean;
  namedCards?: ReadonlySet<string>;
}

/**
 * Upstream stores effect text as HTML with its own CSS classes. The build parses
 * it into tokens; we render suit references as themed spans so card text matches
 * the app rather than the calculator. No HTML is injected.
 */
export function CardTextView({ tokens, match = null, sweeping = false, namedCards }: Props) {
  if (!tokens?.length) return null;
  return (
    <>
      {tokens.map((token, i) => {
        if (token.kind === 'break') return <br key={i} />;
        const hit = matches(token, match, namedCards);
        const className = [
          token.kind === 'ref' ? `suit suit-${token.suit}` : '',
          hit && sweeping ? 'ref-sweep' : '',
        ].filter(Boolean).join(' ') || undefined;
        const style = {
          ...(token.bold ? { fontWeight: 700 } : {}),
          ...(token.kind === 'ref'
            ? {
                ['--ref-c' as string]: `var(--suit-${token.suit}-ink)`,
                ['--ref-hot' as string]: `var(--suit-${token.suit}-hot)`,
              }
            : {}),
        };
        return (
          <span key={i} className={className} style={style as React.CSSProperties}>
            {token.value}
          </span>
        );
      })}
    </>
  );
}
