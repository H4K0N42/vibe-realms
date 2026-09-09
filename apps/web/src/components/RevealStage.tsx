import { useEffect, useRef, useState } from 'react';

import type { CardId, ClientMessage, PublicGameState, PublicReveal } from '@fr/shared';

import { cardsById, isRelated } from '../cards.ts';
import type { Dictionary } from '../i18n.ts';
import { ActionChoices } from './ActionChoices.tsx';
import { Card } from './Card.tsx';

interface Props {
  reveal: PublicReveal;
  state: PublicGameState;
  dict: Dictionary;
  myPlayerId: string | null;
  send: (m: ClientMessage) => void;
}

interface Delta {
  cardId: CardId;
  bonus: number;
  penalty: number;
  blankedNow: boolean;
  unblankedNow: boolean;
}

/**
 * What the newest card did to the cards already face up. Fantasy Realms scoring
 * is not additive: a card can blank earlier ones, or rescue them, so each
 * step is a fresh scoring and the interesting part is the difference.
 */
function deltasFor(reveal: PublicReveal, index: number): Delta[] {
  const step = reveal.steps[index];
  const prev = reveal.steps[index - 1];
  if (!step || !prev) return [];
  const before = new Map(prev.breakdown.map((r) => [r.cardId, r]));
  const out: Delta[] = [];
  for (const row of step.breakdown) {
    const was = before.get(row.cardId);
    if (!was) continue; // the card that was just turned over
    const bonus = row.bonus - was.bonus;
    const penalty = row.penalty - was.penalty;
    const blankedNow = row.blanked && !was.blanked;
    const unblankedNow = !row.blanked && was.blanked;
    if (bonus || penalty || blankedNow || unblankedNow) {
      out.push({ cardId: row.cardId, bonus, penalty, blankedNow, unblankedNow });
    }
  }
  return out;
}

/** Counts toward a new value so the total visibly ticks up. */
function useCountUp(target: number, ms = 420): number {
  const [shown, setShown] = useState(target);
  const from = useRef(target);
  useEffect(() => {
    const startedAt = performance.now();
    const origin = from.current;
    let raf = 0;
    const tick = (t: number) => {
      const k = Math.min(1, (t - startedAt) / ms);
      const eased = 1 - (1 - k) ** 3;
      setShown(Math.round(origin + (target - origin) * eased));
      if (k < 1) raf = requestAnimationFrame(tick);
      else from.current = target;
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [target, ms]);
  return shown;
}

export function RevealStage({ reveal, state, dict, myPlayerId, send }: Props) {
  const owner = state.players.find((p) => p.id === reveal.playerId);
  const isOwner = reveal.playerId === myPlayerId;
  // A dropped player cannot click; anyone else may move their reveal along.
  const mayDrive = isOwner || owner?.connected === false;

  const latest = reveal.steps.length - 1;
  // Once choices are being made the server re-scores the whole hand, so the
  // total keeps reacting after the last card is face up.
  const total = reveal.finalTotal ?? reveal.steps.at(-1)?.total ?? 0;
  const shownTotal = useCountUp(total);
  const deltas = deltasFor(reveal, latest);
  const current = reveal.steps.at(-1);

  const [answered, setAnswered] = useState<Record<CardId, boolean>>({});
  useEffect(() => setAnswered({}), [reveal.playerId]);

  const faceDown = Math.max(0, reveal.handSize - reveal.steps.length);
  const needsChoices = reveal.complete && reveal.pendingActions.length > 0;

  return (
    <main className="reveal">
      <header className="reveal-head">
        <p className="reveal-who">
          {owner?.nickname ?? '?'}
          <span className="reveal-progress"> · {reveal.playerIndex + 1}/{reveal.playerCount}</span>
          {owner?.connected === false ? <span className="badge">{dict.t('table.offline')}</span> : null}
        </p>
        <p className={`reveal-total${total < 0 ? ' negative' : ''}`}>{shownTotal}</p>
      </header>

      <section className="reveal-row">
        {reveal.steps.map((step, i) => {
          const row = current?.breakdown.find((r) => r.cardId === step.cardId);
          const delta = deltas.find((d) => d.cardId === step.cardId);
          const newest = reveal.steps[latest]?.cardId;
          // Cards the newest one interacts with, lit in that card's own suit
          // colour: a Flame lights up what it touches in red.
          const related = !!newest && i !== latest && (!!delta || isRelated(newest, step.cardId));
          const hlSuit = newest ? cardsById[newest]?.suit ?? 'wild' : 'wild';
          return (
            <div
              key={step.cardId}
              className={`reveal-slot${i === latest ? ' just-flipped' : ''}${related ? ' related' : ''}${row?.blanked ? ' is-blanked' : ''}`}
              style={related ? ({ ['--hl' as string]: `var(--suit-${hlSuit}-ink)` } as React.CSSProperties) : undefined}
            >
              <Card id={step.cardId} dict={dict} blanked={row?.blanked} />
              <div className="reveal-values">
                <span className="base">{row?.base ?? cardsById[step.cardId]?.strength ?? 0}</span>
                {row && row.bonus ? <span className="pos">+{row.bonus}</span> : null}
                {row && row.penalty ? <span className="neg">{row.penalty}</span> : null}
              </div>
              {delta ? (
                // Keyed by step so it remounts and replays on every new card.
                <div key={`${latest}-${delta.cardId}`} className="delta-float">
                  {delta.blankedNow ? <span className="d-blank">{dict.t('reveal.blanked')}</span> : null}
                  {delta.unblankedNow ? <span className="d-unblank">{dict.t('reveal.freed')}</span> : null}
                  {delta.bonus ? <span className="d-pos">+{delta.bonus}</span> : null}
                  {delta.penalty ? <span className="d-neg">{delta.penalty}</span> : null}
                </div>
              ) : null}
            </div>
          );
        })}
        {Array.from({ length: faceDown }, (_, i) => (
          <div key={`back-${i}`} className="reveal-slot">
            <div className="card card-back" />
          </div>
        ))}
      </section>

      <section className="reveal-controls">
        {!reveal.complete ? (
          mayDrive ? (
            <button className="primary" onClick={() => send({ t: 'revealNext' })}>
              {dict.t('reveal.next', { have: reveal.steps.length, total: reveal.handSize })}
            </button>
          ) : (
            <p className="hint">{dict.t('reveal.watching', { name: owner?.nickname ?? '' })}</p>
          )
        ) : null}
      </section>

      {reveal.complete ? (
        <section className="reveal-extras">
          {needsChoices && isOwner ? (
            <ActionChoices
              hand={reveal.pendingActions}
              dict={dict}
              answered={answered}
              send={(m) => {
                if (m.t === 'resolveAction') setAnswered((a) => ({ ...a, [m.cardId]: true }));
                send(m);
              }}
              targets={reveal.steps.map((s) => s.cardId)}
            />
          ) : null}
          {needsChoices && !isOwner ? (
            <p className="hint">{dict.t('reveal.choosing', { name: owner?.nickname ?? '' })}</p>
          ) : null}
          {!needsChoices && mayDrive ? (
            <button className="primary" onClick={() => send({ t: 'revealFinish' })}>
              {reveal.playerIndex + 1 < reveal.playerCount
                ? dict.t('reveal.nextPlayer') : dict.t('reveal.showScores')}
            </button>
          ) : null}
        </section>
      ) : null}
    </main>
  );
}
