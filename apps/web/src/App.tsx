import {
  useCallback, useEffect, useMemo, useState,
  type ComponentProps, type Dispatch, type PointerEvent as ReactPointerEvent,
  type SetStateAction,
} from 'react';

import { DISCARD_LIMIT, MIN_PLAYERS, type CardId, type ExpansionConfig } from '@fr/shared';

import { Card } from './components/Card.tsx';
import { CardOverlay } from './components/CardOverlay.tsx';
import { RevealStage } from './components/RevealStage.tsx';
import { useDragEngine, type DragState, type DropResult, type Zone } from './dragEngine.ts';
import { CardTextView } from './components/CardText.tsx';
import { cardsById, harmedBy } from './cards.ts';
import { PRIMARY_LOCALES, useDictionary, type Dictionary } from './i18n.ts';
import { copyText, inviteLink } from './share.ts';
import { useGame } from './useGame.ts';

const localeKey = 'fr:locale';

export default function App() {
  const [roomCode, setRoomCode] = useState<string | null>(null);
  const [nickname, setNickname] = useState('');
  const [locale, setLocale] = useState(() => localStorage.getItem(localeKey) ?? 'de');
  const dict = useDictionary(locale);

  const pickLocale = useCallback((next: string) => {
    localStorage.setItem(localeKey, next);
    setLocale(next);
  }, []);

  const leave = useCallback(() => {
    if (roomCode) localStorage.removeItem(`fr:resume:${roomCode}`);
    setRoomCode(null);
  }, [roomCode]);

  if (!dict) return <main className="center"><p>…</p></main>;

  if (!roomCode || !nickname) {
    return <Home dict={dict} onEnter={(code, name) => { setRoomCode(code); setNickname(name); }}
                 locale={locale} setLocale={pickLocale} />;
  }
  return <Room code={roomCode} nickname={nickname} dict={dict}
               locale={locale} setLocale={pickLocale} onLeave={leave} />;
}

function LocalePicker({ dict, locale, setLocale }: {
  dict: Dictionary; locale: string; setLocale: (l: string) => void;
}) {
  return (
    <select className="locale" value={locale} onChange={(e) => setLocale(e.target.value)}
            aria-label={dict.t('bar.language')}>
      {PRIMARY_LOCALES.map((l) => <option key={l} value={l}>{l.toUpperCase()}</option>)}
    </select>
  );
}

function Home({ dict, onEnter, locale, setLocale }: {
  dict: Dictionary;
  onEnter: (code: string, nickname: string) => void;
  locale: string;
  setLocale: (l: string) => void;
}) {
  // An invite link carries the room in the query string, so the code is already
  // filled in for whoever follows it.
  const [code, setCode] = useState(
    () => new URLSearchParams(location.search).get('room')?.toUpperCase() ?? '',
  );
  const [name, setName] = useState(localStorage.getItem('fr:nickname') ?? '');
  const [busy, setBusy] = useState(false);

  const enter = (roomCode: string) => {
    localStorage.setItem('fr:nickname', name.trim());
    onEnter(roomCode.trim().toUpperCase(), name.trim());
  };

  // Any code at all means the player means to join, even a partial one: the
  // button says so straight away and only unlocks once the code is complete.
  const joining = code.trim().length > 0;
  const blocked = !name.trim() || busy || (joining && code.trim().length < 4);
  const act = () => { if (joining) enter(code); else void create(); };

  const create = async () => {
    setBusy(true);
    try {
      const res = await fetch('/api/rooms', { method: 'POST', body: '{}' });
      const { code: newCode } = (await res.json()) as { code: string };
      enter(newCode);
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className="center home">
      <h1>{dict.t('app.title')}</h1>
      <p className="tagline">{dict.t('app.tagline')}</p>
      {/* Whoever follows an invite link has never seen the game. Three lines is
          the whole loop, and it costs nothing to say them. */}
      <ol className="how">
        <li>{dict.t('app.how.1')}</li>
        <li>{dict.t('app.how.2')}</li>
        <li>{dict.t('app.how.3')}</li>
      </ol>
      <p className="hint">{dict.t('app.players')}</p>

      <label>
        {dict.t('home.name')}
        <input value={name} onChange={(e) => setName(e.target.value)} maxLength={20}
               placeholder={dict.t('home.namePlaceholder')} />
      </label>
      <input className="code-input" value={code} maxLength={4}
             onChange={(e) => setCode(e.target.value.toUpperCase())}
             onKeyDown={(e) => { if (e.key === 'Enter' && !blocked) act(); }}
             placeholder={dict.t('home.codePlaceholder')} aria-label={dict.t('home.code')} />
      {/* One button. Typing a code turns "new game" into "join": the two are
          never both relevant, and having both invited picking the wrong one. */}
      <button className="primary" disabled={blocked} onClick={act}>
        {joining ? dict.t('home.join') : dict.t('home.new')}
      </button>
      <p className="hint">{dict.t('home.hint')}</p>
      <LocalePicker dict={dict} locale={locale} setLocale={setLocale} />
    </main>
  );
}

/**
 * Always-present chrome: which room you are in, how to invite someone to it,
 * the language, and the way out. Every one of these used to be missing once a
 * game had started.
 */
function AppBar({ code, dict, locale, setLocale, onLeave }: {
  code: string; dict: Dictionary; locale: string;
  setLocale: (l: string) => void; onLeave: () => void;
}) {
  const [copied, setCopied] = useState(false);
  const [confirming, setConfirming] = useState(false);

  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 1800);
    return () => clearTimeout(timer);
  }, [copied]);

  const copy = async () => {
    if (await copyText(inviteLink(code))) setCopied(true);
  };

  return (
    <div className="app-bar">
      {/* The code is the invite: clicking it copies a link that fills it in. */}
      <button className="room-code" onClick={copy} title={dict.t('bar.copy')}>
        <span className="room-label">{dict.t('bar.room')}</span>
        <code>{code}</code>
        <span className="copy-mark" aria-hidden="true">{copied ? '✓' : '⧉'}</span>
      </button>
      <span className="copied" role="status">{copied ? dict.t('bar.copied') : ''}</span>

      <span className="spacer" />
      <LocalePicker dict={dict} locale={locale} setLocale={setLocale} />
      {confirming ? (
        <>
          <button className="danger" onClick={onLeave}>{dict.t('bar.leaveConfirm')}</button>
          <button onClick={() => setConfirming(false)}>{dict.t('bar.leaveCancel')}</button>
        </>
      ) : (
        <button onClick={() => setConfirming(true)}>{dict.t('bar.leave')}</button>
      )}
    </div>
  );
}

function Room({ code, nickname, dict, locale, setLocale, onLeave }: {
  code: string; nickname: string; dict: Dictionary; locale: string;
  setLocale: (l: string) => void; onLeave: () => void;
}) {
  const game = useGame(code, nickname);
  const [order, setOrder] = useState<CardId[]>([]);
  const [hovered, setHovered] = useState<CardId | null>(null);
  /** Card shown full size after a tap or Space, the only way to read a long
      rules text without a mouse to hover with. */
  const [opened, setOpened] = useState<CardId | null>(null);

  const myTurn = game.state?.turn === game.playerId;
  const drew = game.hand.length > 7;
  const canDraw = myTurn && !drew;
  const canDiscard = myTurn && drew;

  // The server owns the hand; adopt its order whenever it changes.
  useEffect(() => {
    setOrder(game.hand);
  }, [game.hand.join(',')]);

  const leaveRoom = useCallback(() => {
    game.send({ t: 'leave' });
    onLeave();
  }, [game, onLeave]);

  /** Insert a hand card at `index` counted in the hand without that card. */
  const moveInHand = useCallback((cardId: CardId, index: number) => {
    const without = order.filter((c) => c !== cardId);
    const at = Math.max(0, Math.min(index, without.length));
    const next = [...without.slice(0, at), cardId, ...without.slice(at)];
    if (next.some((c, i) => c !== order[i])) {
      setOrder(next);
      game.send({ t: 'reorderHand', cards: next });
    }
  }, [game, order]);

  const handleDrop = useCallback(
    ({ cardId, from, to, index }: DropResult) => {
      // Released without ever breaking loose: that is a tap, and a tap means
      // "let me read this", not "play it". Playing stays a deliberate drag.
      if (to === null) {
        if (cardId) setOpened(cardId);
        return;
      }
      // Cards stay draggable when the move is not yours to make, because
      // picking one up is how you read it, so legality is decided on release.
      if (from === 'deck' && to === 'hand' && canDraw) {
        game.send({ t: 'draw', from: 'deck' });
        return;
      }
      if (from === 'discard' && to === 'hand' && cardId && canDraw) {
        game.send({ t: 'draw', from: 'discard', cardId });
        return;
      }
      if (from === 'hand' && to === 'discard' && cardId && canDiscard) {
        game.send({ t: 'discard', cardId });
        return;
      }
      if (from === 'hand' && to === 'hand' && cardId && index !== null) {
        moveInHand(cardId, index);
      }
    },
    [game, moveInHand, canDraw, canDiscard],
  );

  const { drag, begin } = useDragEngine(handleDrop);

  // What the hovered card looks like to every other card's rules text: its suit,
  // and its name in the current language (that is how references are written).
  const match = useMemo(() => {
    if (!hovered) return null;
    const def = cardsById[hovered];
    if (!def) return null;
    const text = dict.card(hovered);
    return {
      id: hovered,
      suit: def.suit,
      name: text.name,
      // The engine's verdict on what this card damages. See cards.ts.
      harms: new Set(harmedBy[hovered] ?? []),
      refSuits: new Set(def.relatedSuits),
      refCardNames: new Set(def.relatedCards),
    };
  }, [hovered, dict]);

  const bar = <AppBar code={code} dict={dict} locale={locale}
                      setLocale={setLocale} onLeave={leaveRoom} />;
  const overlay = opened
    ? <CardOverlay id={opened} dict={dict} onClose={() => setOpened(null)} />
    : null;

  if (game.scores) {
    return (
      <>
        {bar}
        <Scores game={game} dict={dict} onLeave={onLeave} />
      </>
    );
  }

  // Scoring is a presentation: one player at a time, card by card.
  if (game.state?.phase === 'scoring' && game.state.reveal) {
    return (
      <>
        {bar}
        <RevealStage reveal={game.state.reveal} state={game.state} dict={dict}
                     myPlayerId={game.playerId} send={game.send} />
      </>
    );
  }

  if (game.state?.phase === 'lobby') {
    return (
      <>
        {bar}
        <main className="lobby">
          <h1>{dict.t('app.title')}</h1>
          <p className="hint">{dict.t('lobby.invite')}</p>
          <ul className="players">
            {game.state.players.map((p) => (
              <li key={p.id}>
                {p.nickname}
                {p.id === game.playerId ? <span className="you"> {dict.t('lobby.you')}</span> : null}
                {p.connected ? null : <span className="badge">{dict.t('table.offline')}</span>}
              </li>
            ))}
          </ul>
          <Settings game={game} dict={dict} />
          <button className="primary" disabled={game.state.players.length < MIN_PLAYERS}
                  onClick={() => game.send({ t: 'start' })}>
            {dict.t('lobby.start')}
          </button>
          {game.state.players.length < MIN_PLAYERS
            ? <p className="hint">{dict.t('lobby.needPlayers', { n: MIN_PLAYERS })}</p> : null}
          {game.error ? <p className="error">{game.error}</p> : null}
        </main>
      </>
    );
  }

  // Preview of where a dragged hand card would land.
  const shown = (() => {
    if (!drag || drag.from !== 'hand' || drag.over !== 'hand' || drag.overIndex === null) return order;
    const without = order.filter((c) => c !== drag.cardId);
    const at = Math.min(drag.overIndex, without.length);
    return [...without.slice(0, at), drag.cardId!, ...without.slice(at)];
  })();

  const turnHolder = game.state?.players.find((p) => p.id === game.state?.turn);
  const discardCount = game.state?.discard.length ?? 0;

  const label = canDraw
    ? dict.t('table.yourTurnDraw')
    : canDiscard
      ? dict.t('table.yourTurnDiscard')
      : turnHolder
        ? dict.t('table.waitingFor', { name: turnHolder.nickname })
        : dict.t('table.waiting');

  return (
    <>
      {bar}
      <main className="table">
        <header className="table-head">
          <ul className="seats">
            {game.state?.players.map((p) => (
              <li key={p.id} className={`${p.id === game.state?.turn ? 'active' : ''} ${p.connected ? '' : 'offline'}`}>
                {p.nickname} <span className="count">{p.handCount}</span>
                {p.connected ? null : <span className="badge">{dict.t('table.offline')}</span>}
                {p.hasVotedToEnd ? <span className="badge voted">✓</span> : null}
              </li>
            ))}
          </ul>
          {/* Whose turn it is, said out loud rather than only ringed in blue --
              and announced, so it does not depend on watching the header. */}
          <p className={`turn-banner${myTurn ? ' mine' : ''}`} aria-live="polite">{label}</p>
        </header>

        {game.state?.endVote ? <EndVote game={game} dict={dict} /> : null}

        <section className="board">
          <div className={`discard-zone${drag?.over === 'discard' && drag.from === 'hand' ? ' zone-hot' : ''}`}
               data-zone="discard">
            <p className="zone-count">
              {dict.t('table.discardCount', { n: discardCount, max: DISCARD_LIMIT })}
            </p>
            <div className="discard-row">
              {/* The draw pile sits in the first of the ten places. Nothing is
                  lost by taking it: discarding the tenth card ends the game on
                  the spot, so a tenth face-up card is never there to be seen. */}
              <div className={`card card-back deck-card${canDraw ? ' drawable' : ''}`}
                   role="button" tabIndex={0}
                   aria-label={dict.t('card.deckAria', { n: game.state?.drawPileCount ?? 0 })}
                   aria-disabled={!canDraw}
                   onPointerDown={canDraw ? begin(null, 'deck') : undefined}
                   onKeyDown={(e) => {
                     if (e.key === 'Enter' && canDraw) {
                       e.preventDefault();
                       game.send({ t: 'draw', from: 'deck' });
                     }
                   }}>
                <span className="deck-count">{game.state?.drawPileCount ?? 0}</span>
              </div>
              {/* One outlined place per card that can still land here, so the
                  distance to the end of the game is visible at a glance. */}
              {Array.from({ length: DISCARD_LIMIT - 1 }, (_, i) => {
                const id = game.state?.discard[i];
                if (!id) return <div key={`empty-${i}`} className="card card-empty" />;
                return (
                  <CardSlot key={id} id={id} zone="discard" dict={dict} match={match}
                            begin={begin} drag={drag}
                            hovered={hovered} setHovered={setHovered} setOpened={setOpened}
                            onEnter={canDraw
                              ? () => game.send({ t: 'draw', from: 'discard', cardId: id })
                              : null} />
                );
              })}
            </div>
          </div>
        </section>

        <section className={`hand-zone${drag && drag.from !== 'hand' && drag.over === 'hand' ? ' zone-hot' : ''}`}
                 data-zone="hand">
          <div className="cards">
            {shown.map((id, i) => (
              <CardSlot key={id} id={id} zone="hand" handSlot dict={dict} match={match}
                        begin={begin} drag={drag}
                        blanked={game.blanked.includes(id)}
                        hovered={hovered} setHovered={setHovered} setOpened={setOpened}
                        onEnter={canDiscard ? () => game.send({ t: 'discard', cardId: id }) : null}
                        onMove={(delta) => moveInHand(id, i + delta)} />
            ))}
          </div>
          <p className="hint keyboard-hint">{dict.t('table.keyboardHint')}</p>
        </section>

        {drag?.lifted ? <DragGhost drag={drag} dict={dict} /> : null}

        {game.error ? <p className="error">{game.error}</p> : null}
        {game.status !== 'open'
          ? <p className="error">{dict.t('table.disconnected')}</p> : null}
      </main>
      {overlay}
    </>
  );
}

/**
 * A card you can act on. Draggable as before, but also focusable and operable
 * from the keyboard: Enter plays it, Space reads it, Alt+arrows sort the hand.
 */
function CardSlot({
  id, zone, handSlot, dict, match, begin, drag, blanked,
  hovered, setHovered, setOpened, onEnter, onMove,
}: {
  id: CardId;
  zone: Zone;
  handSlot?: boolean;
  dict: Dictionary;
  match: ComponentProps<typeof Card>['match'];
  begin: ((cardId: CardId | null, from: Zone) => (e: ReactPointerEvent) => void) | null;
  drag: DragState | null;
  blanked?: boolean;
  hovered: CardId | null;
  setHovered: Dispatch<SetStateAction<CardId | null>>;
  setOpened: (id: CardId) => void;
  /** What Enter does here, or null when the move is not legal right now. */
  onEnter: (() => void) | null;
  /** Alt+arrow, hand only. */
  onMove?: (delta: number) => void;
}) {
  const def = cardsById[id];
  const text = dict.card(id);
  const suitName = dict.ui(`suit.${def?.suit ?? 'wild'}`, def?.suit ?? '');
  const aria = dict.t(blanked ? 'card.ariaBlanked' : 'card.aria', {
    name: text.name, strength: def?.strength ?? '?', suit: suitName,
  });

  return (
    <div
      {...(handSlot ? { 'data-hand-slot': true } : {})}
      role="button"
      tabIndex={0}
      aria-label={aria}
      className={`slot${drag?.cardId === id && drag.lifted ? ' is-dragging' : ''}${hovered === id ? ' is-hovered' : ''}`}
      onPointerDown={begin ? begin(id, zone) : undefined}
      onPointerEnter={() => setHovered(id)}
      onPointerLeave={() => setHovered((h) => (h === id ? null : h))}
      // Focus lights up the same relationships hovering does, so the
      // highlighting is not something only a mouse can reach.
      onFocus={() => setHovered(id)}
      onBlur={() => setHovered((h) => (h === id ? null : h))}
      onKeyDown={(e) => {
        if (e.key === ' ') { e.preventDefault(); setOpened(id); return; }
        if (e.key === 'Enter' && onEnter) { e.preventDefault(); onEnter(); return; }
        if (e.altKey && onMove && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) {
          e.preventDefault();
          onMove(e.key === 'ArrowRight' ? 1 : -1);
        }
      }}
    >
      <Card id={id} dict={dict} match={match} blanked={blanked} />
    </div>
  );
}

/** The card that follows the pointer while it is held. */
function DragGhost({ drag, dict }: { drag: DragState; dict: Dictionary }) {
  return (
    <div className="drag-ghost"
         style={{ transform: `translate3d(${drag.x}px, ${drag.y}px, 0)`, width: drag.width }}>
      {drag.cardId
        ? <Card id={drag.cardId} dict={dict} dragging />
        : <div className="card card-back" style={{ height: drag.height }} />}
    </div>
  );
}

function EndVote({ game, dict }: { game: ReturnType<typeof useGame>; dict: Dictionary }) {
  const vote = game.state?.endVote;
  if (!vote) return null;
  const mine = vote.votes.includes(game.playerId ?? '');
  const gone = game.state?.players.filter((p) => !p.connected).map((p) => p.nickname).join(', ');
  return (
    <aside className="end-vote">
      <p>{dict.t('vote.gone', { names: gone ?? '' })}</p>
      <p>{dict.t('vote.question', { have: vote.votes.length, needed: vote.needed })}</p>
      <button className="primary" disabled={mine} onClick={() => game.send({ t: 'voteEndGame', vote: true })}>
        {mine ? dict.t('vote.waiting') : dict.t('vote.yes')}
      </button>
      {mine
        ? <button onClick={() => game.send({ t: 'voteEndGame', vote: false })}>{dict.t('vote.withdraw')}</button>
        : null}
    </aside>
  );
}

function Settings({ game, dict }: { game: ReturnType<typeof useGame>; dict: Dictionary }) {
  const s = game.settings;
  if (!s) return null;
  const setExp = (patch: Partial<ExpansionConfig>) =>
    game.send({ t: 'updateSettings', settings: { expansions: { ...s.expansions, ...patch } } });

  return (
    <fieldset className="settings">
      <legend>{dict.t('lobby.expansions')}</legend>
      <label><input type="checkbox" checked={s.expansions.cursedHoardSuits}
                    onChange={(e) => setExp({ cursedHoardSuits: e.target.checked })} />
        <span>{dict.t('lobby.exp.suits')}</span></label>
      <label><input type="checkbox" checked={s.expansions.cursedHoardItems}
                    onChange={(e) => setExp({ cursedHoardItems: e.target.checked })} />
        <span>{dict.t('lobby.exp.items')}</span></label>
    </fieldset>
  );
}

function Scores({ game, dict, onLeave }: {
  game: ReturnType<typeof useGame>; dict: Dictionary; onLeave: () => void;
}) {
  const ranked = useMemo(
    () => [...(game.scores?.scores ?? [])].sort((a, b) => b.total - a.total),
    [game.scores],
  );
  const nameOf = (id: string) => game.state?.players.find((p) => p.id === id)?.nickname ?? id;
  const top = ranked[0]?.total ?? 0;
  // Bars are drawn against the winner, from the lowest score up, so a negative
  // total still has somewhere to sit.
  const floor = Math.min(0, ...ranked.map((s) => s.total));
  const width = (total: number) =>
    top === floor ? 100 : Math.max(2, ((total - floor) / (top - floor)) * 100);

  return (
    <main className="scores">
      <h1>{game.scores?.reason === 'earlyVote' ? dict.t('scores.early') : dict.t('scores.final')}</h1>

      {/* The ranking first and at a glance: who won, and by how much. The
          card-by-card table is the evidence, not the headline. */}
      <ol className="podium">
        {ranked.map((score, i) => (
          <li key={score.playerId} className={i === 0 ? 'winner' : ''}>
            <span className="rank">{i + 1}</span>
            <span className="who">{nameOf(score.playerId)}</span>
            <span className="bar"><span style={{ width: `${width(score.total)}%` }} /></span>
            <span className="total">{score.total}</span>
            <span className="gap">
              {i === 0 ? dict.t('scores.winner') : dict.t('scores.behind', { n: top - score.total })}
            </span>
          </li>
        ))}
      </ol>

      {ranked.map((score) => (
        <details key={score.playerId} className="score-block">
          <summary>
            {nameOf(score.playerId)} · {score.total} {dict.t('scores.points')}
            <span className="summary-hint"> ({dict.t('scores.details')})</span>
          </summary>
          <table>
            <thead>
              <tr>
                <th>{dict.t('scores.col.card')}</th>
                <th className="num">{dict.t('scores.col.base')}</th>
                <th className="num">{dict.t('scores.col.bonus')}</th>
                <th className="num">{dict.t('scores.col.penalty')}</th>
                <th>{dict.t('scores.col.effect')}</th>
              </tr>
            </thead>
            <tbody>
              {score.breakdown.map((row) => (
                <tr key={row.cardId} className={row.blanked ? 'blanked' : ''}>
                  <td>{dict.card(row.cardId).name}</td>
                  <td className="num">{row.base}</td>
                  <td className="num pos">{row.bonus ? `+${row.bonus}` : ''}</td>
                  <td className="num neg">{row.penalty ? row.penalty : ''}</td>
                  <td className="effect">
                    <CardTextView tokens={dict.card(row.cardId).bonus} />
                    <CardTextView tokens={dict.card(row.cardId).penalty} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </details>
      ))}

      <div className="score-actions">
        {/* Same room, same people: nobody has to pass the code around again. */}
        <button className="primary" onClick={() => game.send({ t: 'rematch' })}>
          {dict.t('scores.rematch')}
        </button>
        <button onClick={onLeave}>{dict.t('scores.home')}</button>
      </div>
      <p className="hint">{dict.t('scores.rematchHint')}</p>
    </main>
  );
}
