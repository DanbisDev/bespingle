import { useCallback, useEffect, useRef, useState } from 'react';
import type { Player } from './world';
import type { CancelMove, ChatMessage, ServerMessage, Signal, Send, Move, MoveResult } from './protocol';

type PendingMove = { resolve: (result: MoveResult) => void; timer: ReturnType<typeof setTimeout> };

export function useGame() {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const currentCarpet = useRef('');
  const currentSelf = useRef('');
  const [players, setPlayers] = useState<Player[]>([]);
  const [selfId, setSelfId] = useState('');
  const [status, setStatus] = useState<'offline' | 'connecting' | 'connected' | 'lost'>('offline');
  const [error, setError] = useState('');
  const socket = useRef<WebSocket | null>(null);
  const signalHandler = useRef<(signal: Signal) => void>(() => {});
  const pendingSignals = useRef<Signal[]>([]);
  const [signalRevision, setSignalRevision] = useState(0);
  const clockOffset = useRef(Date.now() - performance.now());
  const clockReady = useRef(false);
  const nextMoveId = useRef(0);
  const pendingMoves = useRef(new Map<number, PendingMove>());

  // Membership updates and signaling can arrive in the same event-loop turn.
  // Deliver signals only after React commits that membership and media cleanup.
  useEffect(() => {
    for (const signal of pendingSignals.current.splice(0)) signalHandler.current(signal);
  }, [players, selfId, signalRevision]);

  const serverNow = useCallback(() => performance.now() + clockOffset.current, []);

  const clearMoves = useCallback(() => {
    for (const [requestId, pending] of pendingMoves.current) {
      clearTimeout(pending.timer);
      pending.resolve({ type: 'move-result', requestId, accepted: false, reason: 'disconnected' });
    }
    pendingMoves.current.clear();
  }, []);

  const send: Send = useCallback((message) => {
    if (socket.current?.readyState === WebSocket.OPEN) socket.current.send(JSON.stringify(message));
  }, []);

  const requestMove = useCallback((message: Record<string, unknown>) => new Promise<MoveResult>((resolve) => {
    const ws = socket.current;
    const requestId = ++nextMoveId.current;
    if (ws?.readyState !== WebSocket.OPEN) {
      resolve({ type: 'move-result', requestId, accepted: false, reason: 'disconnected' });
      return;
    }
    const timer = setTimeout(() => {
      if (!pendingMoves.current.delete(requestId)) return;
      resolve({ type: 'move-result', requestId, accepted: false, reason: 'timeout' });
    }, 3000);
    pendingMoves.current.set(requestId, { resolve, timer });
    ws.send(JSON.stringify({ ...message, requestId }));
  }), []);

  const move: Move = useCallback((x, y, facing, sprint = false, portal = false) => requestMove({ type: 'move', x, y, facing, sprint, portal }), [requestMove]);
  const cancelMove: CancelMove = useCallback(() => requestMove({ type: 'move-cancel' }), [requestMove]);

  const leave = useCallback(() => {
    const current = socket.current;
    socket.current = null;
    pendingSignals.current = [];
    currentCarpet.current = currentSelf.current = '';
    setMessages([]);
    clearMoves();
    current?.close();
    setPlayers([]);
    setSelfId('');
    setStatus('offline');
    setError('');
  }, [clearMoves]);

  const join = useCallback((name: string, avatar: number, customAvatar = '') => {
    socket.current?.close();
    pendingSignals.current = [];
    currentCarpet.current = currentSelf.current = '';
    setMessages([]);
    clearMoves();
    clockOffset.current = Date.now() - performance.now();
    clockReady.current = false;
    setStatus('connecting');
    setError('');
    const scheme = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const ws = new WebSocket(`${scheme}//${location.host}/ws`);
    socket.current = ws;
    ws.onopen = () => {
      if (socket.current === ws) ws.send(JSON.stringify({ type: 'join', name, avatar, customAvatar }));
    };
    ws.onmessage = (event) => {
      if (socket.current !== ws) return;
      const message = JSON.parse(event.data) as ServerMessage;
      if (message.type === 'welcome' || message.type === 'state') {
        // Retain the least-delayed server clock sample. A delayed state must
        // never rewind a step; performance.now also ignores wall-clock changes.
        if (Number.isFinite(message.serverNow)) {
          const sample = message.serverNow - performance.now();
          clockOffset.current = clockReady.current ? Math.max(clockOffset.current, sample) : sample;
          clockReady.current = true;
        }
        if (message.type === 'welcome') currentSelf.current = message.selfId;
        const carpetId = message.players.find((player) => player.id === currentSelf.current)?.carpetId ?? '';
        if (carpetId !== currentCarpet.current) setMessages([]);
        currentCarpet.current = carpetId;
        setPlayers(message.players);
        if (message.type === 'welcome') {
          setSelfId(message.selfId);
          setStatus('connected');
        }
      } else if (message.type === 'chat') {
        if (currentCarpet.current && message.carpetId === currentCarpet.current) {
          setMessages((current) => [...current.slice(-99), message]);
        }
      } else if (message.type === 'move-result') {
        const pending = pendingMoves.current.get(message.requestId);
        if (pending) {
          clearTimeout(pending.timer);
          pendingMoves.current.delete(message.requestId);
          pending.resolve(message);
        }
      } else if (message.type === 'signal') {
        pendingSignals.current.push(message);
        setSignalRevision((current) => current + 1);
      } else if (message.type === 'error') {
        setError(message.message);
      }
    };
    ws.onclose = () => {
      if (socket.current !== ws) return;
      socket.current = null;
      pendingSignals.current = [];
      currentCarpet.current = currentSelf.current = '';
      setMessages([]);
      clearMoves();
      setStatus('lost');
      setPlayers([]);
      setSelfId('');
      setError('Connection lost. Rejoin the office to reconnect.');
    };
    ws.onerror = () => {
      if (socket.current === ws) setError('Could not reach the office. Check that the Go server is running.');
    };
  }, [clearMoves]);

  useEffect(() => () => {
    socket.current?.close();
    clearMoves();
  }, [clearMoves]);

  return { messages, players, selfId, status, error, join, leave, send, move, cancelMove, serverNow, signalHandler };
}
