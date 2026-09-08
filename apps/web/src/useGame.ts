import { useCallback, useEffect, useRef, useState } from 'react';

import type {
  ClientMessage, PlayerScore, PublicGameState, RoomSettings, ServerMessage,
} from '@fr/shared';

export interface GameConnection {
  status: 'connecting' | 'open' | 'closed';
  state: PublicGameState | null;
  settings: RoomSettings | null;
  hand: string[];
  /** Cards in your hand that are currently blanked by the rest of it. */
  blanked: string[];
  scores: { scores: PlayerScore[]; reason: 'discardPile' | 'earlyVote' } | null;
  playerId: string | null;
  error: string | null;
  send(message: ClientMessage): void;
}

const tokenKey = (code: string) => `fr:resume:${code}`;

export function useGame(roomCode: string | null, nickname: string): GameConnection {
  const socket = useRef<WebSocket | null>(null);
  const [status, setStatus] = useState<GameConnection['status']>('connecting');
  const [state, setState] = useState<PublicGameState | null>(null);
  const [settings, setSettings] = useState<RoomSettings | null>(null);
  const [hand, setHand] = useState<string[]>([]);
  const [blanked, setBlanked] = useState<string[]>([]);
  const [scores, setScores] = useState<GameConnection['scores']>(null);
  const [playerId, setPlayerId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!roomCode) return;
    const url = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`;
    const ws = new WebSocket(url);
    socket.current = ws;
    setStatus('connecting');

    ws.onopen = () => {
      setStatus('open');
      const resumeToken = localStorage.getItem(tokenKey(roomCode)) ?? undefined;
      const join: ClientMessage = resumeToken
        ? { t: 'join', roomCode, nickname, resumeToken }
        : { t: 'join', roomCode, nickname };
      ws.send(JSON.stringify(join));
    };

    ws.onmessage = (event) => {
      const message = JSON.parse(String(event.data)) as ServerMessage;
      switch (message.t) {
        case 'joined':
          setPlayerId(message.playerId);
          localStorage.setItem(tokenKey(message.roomCode), message.resumeToken);
          setError(null);
          break;
        case 'state':
          setState(message.state);
          setSettings(message.settings);
          break;
        case 'hand':
          setHand(message.cards);
          setBlanked(message.blanked ?? []);
          break;
        case 'scores':
          setScores({ scores: message.scores, reason: message.reason });
          break;
        case 'error':
          setError(message.message || message.code);
          break;
      }
    };

    ws.onclose = () => setStatus('closed');
    return () => ws.close();
  }, [roomCode, nickname]);

  const send = useCallback((message: ClientMessage) => {
    const ws = socket.current;
    if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(message));
  }, []);

  return { status, state, settings, hand, blanked, scores, playerId, error, send };
}
