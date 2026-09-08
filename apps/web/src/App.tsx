import { useCallback, useEffect, useMemo, useState } from 'react';

import { DISCARD_LIMIT, MIN_PLAYERS, type CardId, type ExpansionConfig } from '@fr/shared';

import { Card } from './components/Card.tsx';
import { RevealStage } from './components/RevealStage.tsx';
import { useDragEngine, type DragState, type DropResult } from './dragEngine.ts';
import { CardTextView } from './components/CardText.tsx';
import { allCards, cardsById, harmedBy } from './cards.ts';
import { PRIMARY_LOCALES, useDictionary, type Dictionary } from './i18n.ts';
import { useGame } from './useGame.ts';

export default function App() {
  const [roomCode, setRoomCode] = useState<string | null>(null);
  const [nickname, setNickname] = useState('');
  const [locale, setLocale] = useState('de');
  const dict = useDictionary(locale);

  if (!roomCode || !nickname) {
    return <Home onEnter={(code, name) => { setRoomCode(code); setNickname(name); }}
                 locale={locale} setLocale={setLocale} />;
  }
  if (!dict) return <main className="center"><p>…</p></main>;
  return <Room code={roomCode} nickname={nickname} dict={dict} locale={locale} setLocale={setLocale} />;
}

function Home({ onEnter, locale, setLocale }: {
  onEnter: (code: string, nickname: string) => void;
  locale: string;
  setLocale: (l: string) => void;
}) {
  const [code, setCode] = useState('');
  const [name, setName] = useState(localStorage.getItem('fr:nickname') ?? '');
  const [busy, setBusy] = useState(false);

  const enter = (roomCode: string) => {
    localStorage.setItem('fr:nickname', name.trim());
    onEnter(roomCode.trim().toUpperCase(), name.trim());
  };

  // Any code at all means the player means to join, even a partial one -- the
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
      <h1>Fantasy Realms</h1>
      <label>
        Name
        <input value={name} onChange={(e) => setName(e.target.value)} maxLength={20} placeholder="Hagen" />
      </label>
      <input className="code-input" value={code} maxLength={4}
             onChange={(e) => setCode(e.target.value.toUpperCase())}
             onKeyDown={(e) => { if (e.key === 'Enter' && !blocked) act(); }}
             placeholder="CODE" aria-label="Room code" />
      {/* One button. Typing a code turns "new game" into "join": the two are
          never both relevant, and having both invited picking the wrong one. */}
      <button className="primary" disabled={blocked} onClick={act}>
        {joining ? 'Beitreten' : 'Neues Spiel'}
      </button>
      <select value={locale} onChange={(e) => setLocale(e.target.value)} aria-label="Language">
        {PRIMARY_LOCALES.map((l) => <option key={l} value={l}>{l.toUpperCase()}</option>)}
      </select>
    </main>
  );
}

function Room({ code, nickname, dict, locale, setLocale }: {
  code: string; nickname: string; dict: Dictionary; locale: string; setLocale: (l: string) => void;
}) {
  const game = useGame(code, nickname);
  const [order, setOrder] = useState<CardId[]>([]);
  const [hovered, setHovered] = useState<CardId | null>(null);

  const me = game.state?.players.find((p) => p.id === game.playerId);
  const myTurn = game.state?.turn === game.playerId;
  const drew = game.hand.length > 7;

  // The server owns the hand; adopt its order whenever it changes.
  useEffect(() => {
    setOrder(game.hand);
  }, [game.hand.join(',')]);

  const handleDrop = useCallback(
    ({ cardId, from, to, index }: DropResult) => {
      if (to === null) return; // released without breaking loose, or outside a zone
      if (from === 'deck' && to === 'hand') {
        game.send({ t: 'draw', from: 'deck' });
        return;
      }
      if (from === 'discard' && to === 'hand' && cardId) {
        game.send({ t: 'draw', from: 'discard', cardId });
        return;
      }
      if (from === 'hand' && to === 'discard' && cardId) {
        game.send({ t: 'discard', cardId });
        return;
      }
      if (from === 'hand' && to === 'hand' && cardId && index !== null) {
        const without = order.filter((c) => c !== cardId);
        const at = Math.min(index, without.length);
        const next = [...without.slice(0, at), cardId, ...without.slice(at)];
        if (next.some((c, i) => c !== order[i])) {
          setOrder(next);
          game.send({ t: 'reorderHand', cards: next });
        }
      }
    },
    [game, order],
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
      suit: def.suit,
      name: text.name,
      // The engine's verdict on what this card damages -- see cards.ts.
      harms: new Set(harmedBy[hovered] ?? []),
      refSuits: new Set(def.relatedSuits),
      refCardNames: new Set(def.relatedCards),
    };
  }, [hovered, dict]);

  if (game.scores) return <Scores game={game} dict={dict} />;

  // Scoring is a presentation: one player at a time, card by card.
  if (game.state?.phase === 'scoring' && game.state.reveal) {
    return (
      <RevealStage reveal={game.state.reveal} state={game.state} dict={dict}
                   myPlayerId={game.playerId} send={game.send} />
    );
  }

  if (game.state?.phase === 'lobby') {
    return (
      <main className="lobby">
        <h1>Raum <code className="room-code">{code}</code></h1>
        <ul className="players">
          {game.state.players.map((p) => (
            <li key={p.id}>{p.nickname}{p.id === game.playerId ? ' (du)' : ''}</li>
          ))}
        </ul>
        <Settings game={game} />
        <button className="primary" disabled={game.state.players.length < MIN_PLAYERS}
                onClick={() => game.send({ t: 'start' })}>
          Spiel starten
        </button>
        {game.state.players.length < MIN_PLAYERS
          ? <p className="hint">Mindestens {MIN_PLAYERS} Spieler.</p> : null}
        <select value={locale} onChange={(e) => setLocale(e.target.value)} aria-label="Language">
          {PRIMARY_LOCALES.map((l) => <option key={l} value={l}>{l.toUpperCase()}</option>)}
        </select>
        {game.error ? <p className="error">{game.error}</p> : null}
      </main>
    );
  }

  // Preview of where a dragged hand card would land.
  const shown = (() => {
    if (!drag || drag.from !== 'hand' || drag.over !== 'hand' || drag.overIndex === null) return order;
    const without = order.filter((c) => c !== drag.cardId);
    const at = Math.min(drag.overIndex, without.length);
    return [...without.slice(0, at), drag.cardId!, ...without.slice(at)];
  })();

  const canDraw = myTurn && !drew;
  const canDiscard = myTurn && drew;

  return (
    <main className="table">
      <header className="table-head">
        <code className="room-code">{code}</code>
        <ul className="seats">
          {game.state?.players.map((p) => (
            <li key={p.id} className={`${p.id === game.state?.turn ? 'active' : ''} ${p.connected ? '' : 'offline'}`}>
              {p.nickname} <span className="count">{p.handCount}</span>
              {p.connected ? null : <span className="badge">offline</span>}
              {p.hasVotedToEnd ? <span className="badge voted">✓</span> : null}
            </li>
          ))}
        </ul>
      </header>

      {game.state?.endVote ? <EndVote game={game} /> : null}

      <section className="board">
        <div className={`deck-pile${canDraw ? ' drawable' : ''}`}>
          <div className="card card-back deck-card"
               onPointerDown={canDraw ? begin(null, 'deck') : undefined}>
            <span className="deck-count">{game.state?.drawPileCount ?? 0}</span>
          </div>
        </div>

        <div className={`discard-zone${drag?.over === 'discard' && drag.from === 'hand' ? ' zone-hot' : ''}`}
             data-zone="discard">
          <div className="discard-row">
            {/* One outlined place per card the discard area can hold, so the
                distance to the end of the game is visible at a glance. */}
            {Array.from({ length: DISCARD_LIMIT }, (_, i) => {
              const id = game.state?.discard[i];
              if (!id) return <div key={`empty-${i}`} className="card card-empty" />;
              return (
                <div key={id}
                     className={`${drag?.cardId === id && drag.lifted ? 'is-dragging' : ''}${hovered === id ? ' is-hovered' : ''}`}
                     onPointerDown={canDraw ? begin(id, 'discard') : undefined}
                     onPointerEnter={() => setHovered(id)}
                     onPointerLeave={() => setHovered((h) => (h === id ? null : h))}>
                  <Card id={id} dict={dict} match={match} />
                </div>
              );
            })}
          </div>
        </div>
      </section>

      <section className={`hand-zone${drag && drag.from !== 'hand' && drag.over === 'hand' ? ' zone-hot' : ''}`}
               data-zone="hand">
        <p className="zone-label">
          {canDraw ? 'Zieh dir eine Karte herüber' : canDiscard ? 'Karte in die Ablage ziehen' : 'Warte…'}
        </p>
        <div className="cards">
          {shown.map((id) => (
            <div key={id} data-hand-slot
                 className={`slot${drag?.cardId === id && drag.lifted ? ' is-dragging' : ''}${hovered === id ? ' is-hovered' : ''}`}
                 onPointerDown={begin(id, 'hand')}
                 onPointerEnter={() => setHovered(id)}
                 onPointerLeave={() => setHovered((h) => (h === id ? null : h))}>
              {/* The hovered card is matched against itself as well: "+15 for
                  each other Land" should light up LAND on the card saying it. */}
              <Card id={id} dict={dict} match={match} blanked={game.blanked.includes(id)} />
            </div>
          ))}
        </div>
      </section>

      {drag?.lifted ? <DragGhost drag={drag} dict={dict} /> : null}

      {game.error ? <p className="error">{game.error}</p> : null}
      {game.status !== 'open'
        ? <p className="error">Verbindung verloren – Sitzplatz bleibt reserviert.</p> : null}
    </main>
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

function EndVote({ game }: { game: ReturnType<typeof useGame> }) {
  const vote = game.state?.endVote;
  if (!vote) return null;
  const mine = vote.votes.includes(game.playerId ?? '');
  const gone = game.state?.players.filter((p) => !p.connected).map((p) => p.nickname).join(', ');
  return (
    <aside className="end-vote">
      <p><strong>{gone}</strong> ist nicht mehr verbunden.</p>
      <p>Spiel vorzeitig beenden und werten? ({vote.votes.length}/{vote.needed})</p>
      <button className="primary" disabled={mine} onClick={() => game.send({ t: 'voteEndGame', vote: true })}>
        {mine ? 'Warte auf die anderen…' : 'Jetzt werten'}
      </button>
      {mine ? <button onClick={() => game.send({ t: 'voteEndGame', vote: false })}>Zurückziehen</button> : null}
    </aside>
  );
}

function Settings({ game }: { game: ReturnType<typeof useGame> }) {
  const s = game.settings;
  if (!s) return null;
  const setExp = (patch: Partial<ExpansionConfig>) =>
    game.send({ t: 'updateSettings', settings: { expansions: { ...s.expansions, ...patch } } });

  return (
    <fieldset className="settings">
      <legend>Erweiterungen</legend>
      <label><input type="checkbox" checked={s.expansions.cursedHoardSuits}
                    onChange={(e) => setExp({ cursedHoardSuits: e.target.checked })} />
        Verfluchter Schatz (Gebäude/Outsider/Untote)</label>
      <label><input type="checkbox" checked={s.expansions.cursedHoardItems}
                    onChange={(e) => setExp({ cursedHoardItems: e.target.checked })} />
        Verfluchte Gegenstände</label>
      <label><input type="checkbox" checked={s.expansions.phoenixPromo}
                    onChange={(e) => setExp({ phoenixPromo: e.target.checked })} />
        Phönix (Promo)</label>
      <label><input type="checkbox" checked={s.scorePreview}
                    onChange={(e) => game.send({ t: 'updateSettings', settings: { scorePreview: e.target.checked } })} />
        Punkte-Vorschau (einfacher Modus)</label>
    </fieldset>
  );
}

function Scores({ game, dict }: { game: ReturnType<typeof useGame>; dict: Dictionary }) {
  const ranked = useMemo(
    () => [...(game.scores?.scores ?? [])].sort((a, b) => b.total - a.total),
    [game.scores],
  );
  const nameOf = (id: string) => game.state?.players.find((p) => p.id === id)?.nickname ?? id;

  return (
    <main className="scores">
      <h1>{game.scores?.reason === 'earlyVote' ? 'Vorzeitig beendet' : 'Endstand'}</h1>
      {ranked.map((score, i) => (
        <section key={score.playerId} className="score-block">
          <h2><span className="rank">{i + 1}.</span> {nameOf(score.playerId)} <span className="total">{score.total}</span></h2>
          <table>
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
        </section>
      ))}
      <button className="primary" onClick={() => location.reload()}>Neues Spiel</button>
    </main>
  );
}
