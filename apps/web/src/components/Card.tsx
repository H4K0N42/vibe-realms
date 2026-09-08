import { useMemo, useRef } from 'react';

import type { CardId } from '@fr/shared';

import type { Dictionary } from '../i18n.ts';
import { allCards, cardsById } from '../cards.ts';
import { CardTextView, matches, useSweep, type TextMatch } from './CardText.tsx';

interface Props {
  id: CardId;
  dict: Dictionary;
  selected?: boolean;
  dragging?: boolean;
  /** Name, strength and suit only -- used where cards are shown many at a time. */
  compact?: boolean;
  /** Hovered card elsewhere on the table; references to it light up here. */
  match?: TextMatch | null;
  /** Currently blanked: shown struck through and red. */
  blanked?: boolean;
  onClick?: (id: CardId) => void;
}

export function Card({ id, dict, selected, dragging, compact, match, blanked, onClick }: Props) {
  const def = cardsById[id];
  const text = dict.card(id);
  const suit = def?.suit ?? 'wild';

  // Names of the specific cards this text calls out, in the display language.
  const namedCards = useMemo(() => {
    const names = new Set<string>();
    for (const english of def?.relatedCards ?? []) {
      const target = allCards.find((c) => c.name === english);
      names.add(target ? dict.card(target.id).name : english);
    }
    return names;
  }, [def, dict]);

  // Does this card's rules text mention the hovered one?
  const textLit =
    !!match &&
    [...(text.bonus ?? []), ...(text.penalty ?? [])].some((t) => matches(t, match, namedCards));
  // ...and the other way round: does the hovered card's text mention this one?
  // "+20 for each Army" should light up the word ARMY on every Army card.
  const chipLit = !!match && match.refSuits.has(suit);
  // Is this card damaged by the hovered one? Straight from the engine.
  const harmed = !!match && match.harms.has(id);
  // Compared on upstream's English name: that is what relatedCards holds, and
  // it is the engine's identity key regardless of display language.
  const nameLit = !!match && !!def && match.refCardNames.has(def.name);
  const lit = textLit || chipLit || nameLit || harmed;
  const { sweeping, settle } = useSweep(lit);

  // A fixed aspect ratio means long rules text would be clipped (Phoenix is the
  // worst offender, more so when it falls back to English). Step the type down
  // instead; hovering shows the card in full regardless.
  const textLength = [...(text.bonus ?? []), ...(text.penalty ?? [])]
    .reduce((n, t) => n + (t.kind === 'break' ? 0 : t.value.length), 0);
  const density = textLength > 210 ? ' text-xs' : textLength > 140 ? ' text-sm' : '';
  // The sweep keeps running after the match is gone, so the last one is kept
  // alive until the pass finishes -- otherwise there is nothing left to light.
  const lastMatch = useRef<TextMatch | null>(null);
  if (lit && match) lastMatch.current = match;
  const shown = lit ? match : sweeping ? lastMatch.current : null;

  return (
    <div
      className={`card suit-border-${suit}${selected ? ' card-selected' : ''}${dragging ? ' card-dragging' : ''}${compact ? ' card-compact' : ''}${compact ? '' : density}${harmed && sweeping ? ' card-harmed' : ''}${blanked ? ' card-blanked' : ''}`}
      onClick={onClick ? () => onClick(id) : undefined}
      // animationiteration bubbles, so one handler on the card covers every
      // highlighted part of it -- rules text, suit chip and name alike. They
      // start together and stay in step.
      onAnimationIteration={(e) => {
        // Text sweeps and the chip pulse both count: a card may be lit by only
        // one of them, and either finishing a pass is a clean place to stop.
        if (e.animationName.startsWith('ref-')) settle();
      }}
    >
      <header className="card-head">
        <span className={`card-name${nameLit && sweeping ? ' ref-sweep' : ''}`}>
          {text.name}
        </span>
        <span className="card-strength">{def?.strength ?? '?'}</span>
      </header>
      <div className={`card-suit suit-${suit}${chipLit && sweeping ? ' ref-sweep' : ''}`}>
        {dict.ui(`suit.${suit}`, suit)}
      </div>
      {blanked ? (
        <>
          <span className="strike" />
          <span className="blank-label">blockiert</span>
        </>
      ) : null}
      {compact ? null : (
        <div className="card-body">
          {text.bonus ? (
            <p className="card-bonus">
              <CardTextView tokens={text.bonus} match={textLit ? shown : null}
                            sweeping={sweeping} namedCards={namedCards} />
            </p>
          ) : null}
          {text.penalty ? (
            <p className="card-penalty">
              <CardTextView tokens={text.penalty} match={textLit ? shown : null}
                            sweeping={sweeping} namedCards={namedCards} />
            </p>
          ) : null}
        </div>
      )}
      {dict.isFallback(id) ? <span className="card-fallback" title="translation missing">EN</span> : null}
    </div>
  );
}
