import { useCallback, useEffect, useRef, useState } from 'react';
import type { Player } from './world';
import type { CancelMove, ChatMessage, Join, ServerMessage, Signal, Send, Move, MoveResult } from './protocol';
import { pageBuild } from './build';
import { readProfile } from './profile';
import { asTile, claimOffice, holdsOffice, readSession, releaseOffice, saveSession } from './session';
import type { Tile } from './session';

type PendingMove = { resolve: (result: MoveResult) => void; timer: ReturnType<typeof setTimeout> };
type Identity = Pick<Join, 'name' | 'avatar' | 'customAvatar'>;

// A page load rejoins straight away when this browser was last in the office.
function savedIdentity(): Identity | null {
  const profile = readProfile();
  return readSession().inOffice && profile.name.trim() ? { name: profile.name.trim(), avatar: profile.avatar, customAvatar: profile.customAvatar } : null;
}
const retryDelay = (attempt: number) => Math.min(1000 * 2 ** attempt, 10000);
const reloadKey = 'bespingle_reloaded_for';

function sessionStorageGet(key: string) {
  try { return sessionStorage.getItem(key); } catch { return null; }
}
function sessionStorageSet(key: string, value: string) {
  try { sessionStorage.setItem(key, value); } catch { /* Private modes may refuse storage. */ }
}

export function useGame() {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const currentCarpet = useRef('');
  const currentSelf = useRef('');
  const [players, setPlayers] = useState<Player[]>([]);
  const [selfId, setSelfId] = useState('');
  // Reconnecting covers the wait between retries and each rejoin attempt; the
  // join form shows only while offline, connecting from it, or lost.
  const [status, setStatus] = useState<'offline' | 'connecting' | 'connected' | 'reconnecting' | 'lost'>(() => savedIdentity() ? 'reconnecting' : 'offline');
  const [error, setError] = useState('');
  // Server rejections show in the in-game banner and expire on their own. The
  // id restarts the expiry even when a newer error repeats the same text.
  const [serverError, setServerError] = useState({ id: 0, message: '' });
  const serverErrorTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const socket = useRef<WebSocket | null>(null);
  const signalHandler = useRef<(signal: Signal) => void>(() => {});
  const pendingSignals = useRef<Signal[]>([]);
  const [signalRevision, setSignalRevision] = useState(0);
  const clockOffset = useRef(Date.now() - performance.now());
  const clockReady = useRef(false);
  const nextMoveId = useRef(0);
  const pendingMoves = useRef(new Map<number, PendingMove>());
  // Set while the person is in the office, including while rejoining: a close
  // then retries instead of ending the session.
  const inOffice = useRef<Identity | null>(null);
  const retryTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const retries = useRef(0);
  const lastTile = useRef<Tile | null>(null);
  // A page load claiming the office to rejoin from the record.
  const restoring = useRef(false);
  const joinAttempt = useRef(0);

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

  const clearServerError = useCallback(() => {
    clearTimeout(serverErrorTimer.current);
    setServerError((current) => current.message ? { id: current.id, message: '' } : current);
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

  const remember = useCallback((tile: Tile | null) => {
    const saved = lastTile.current;
    if (tile && (tile.x !== saved?.x || tile.y !== saved.y || tile.facing !== saved.facing)) {
      lastTile.current = tile;
      if (holdsOffice()) saveSession({ tile });
    }
  }, []);

  // Leaving or a rejected rejoin: out of the office, the tile still remembered.
  const markOut = useCallback(() => {
    inOffice.current = null;
    joinAttempt.current++;
    clearTimeout(retryTimer.current);
    retries.current = 0;
    if (holdsOffice() || restoring.current) saveSession({ inOffice: false });
    restoring.current = false;
    releaseOffice();
  }, []);

  const leave = useCallback(() => {
    markOut();
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
    clearServerError();
  }, [clearMoves, clearServerError, markOut]);

  // The record's tile is this browser's place, asked for only by the tab holding the office.
  const connect = useCallback((identity: Identity, holder: boolean) => {
    clearTimeout(retryTimer.current);
    socket.current?.close();
    pendingSignals.current = [];
    currentCarpet.current = currentSelf.current = '';
    setMessages([]);
    clearMoves();
    clockOffset.current = Date.now() - performance.now();
    clockReady.current = false;
    setStatus(inOffice.current ? 'reconnecting' : 'connecting');
    setError('');
    clearServerError();
    const scheme = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const ws = new WebSocket(`${scheme}//${location.host}/ws`);
    socket.current = ws;
    ws.onopen = () => {
      // Every join asks for the last tile; the server decides where it lands.
      const tile = lastTile.current ?? (holder ? readSession().tile : null);
      const join: Join = { type: 'join', ...identity, ...tile };
      if (socket.current === ws) ws.send(JSON.stringify(join));
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
        const self = message.players.find((player) => player.id === currentSelf.current);
        remember(asTile(self));
        const carpetId = message.players.find((player) => player.id === currentSelf.current)?.carpetId ?? '';
        if (carpetId !== currentCarpet.current) setMessages([]);
        currentCarpet.current = carpetId;
        setPlayers(message.players);
        if (message.type === 'welcome') {
          setSelfId(message.selfId);
          setStatus('connected');
          inOffice.current = identity;
          retries.current = 0;
          void claimOffice(true).then((held) => {
            if (held && inOffice.current) saveSession({ inOffice: true, tile: lastTile.current });
          });
          // A different build reloads the page, whose load rejoins from the
          // record. Once per build, so a stale cache cannot loop the reload.
          const build = pageBuild();
          if (message.build && build && message.build !== build && sessionStorageGet(reloadKey) !== message.build) {
            sessionStorageSet(reloadKey, message.build);
            if (holdsOffice()) saveSession({ inOffice: true, tile: lastTile.current });
            socket.current = null;
            ws.close();
            location.reload();
          }
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
      } else if (message.type === 'error' && !currentSelf.current) {
        // A rejected join explains why the person is still on the join form.
        // A rejected rejoin puts them there, out of the office.
        if (inOffice.current) {
          socket.current = null;
          ws.close();
          setStatus('offline');
        }
        markOut();
        setError(message.message);
      } else if (message.type === 'error') {
        clearTimeout(serverErrorTimer.current);
        setServerError((current) => ({ id: current.id + 1, message: message.message }));
        serverErrorTimer.current = setTimeout(clearServerError, 5000);
      }
    };
    ws.onclose = () => {
      if (socket.current !== ws) return;
      socket.current = null;
      pendingSignals.current = [];
      currentCarpet.current = currentSelf.current = '';
      setMessages([]);
      clearMoves();
      setPlayers([]);
      setSelfId('');
      clearServerError();
      if (inOffice.current === identity) {
        setStatus('reconnecting');
        retryTimer.current = setTimeout(() => { if (inOffice.current === identity) connect(identity, holdsOffice()); }, retryDelay(retries.current++));
        return;
      }
      markOut();
      setStatus('lost');
      setError('Connection lost. Rejoin the office to reconnect.');
    };
    ws.onerror = () => {
      if (socket.current === ws && !inOffice.current) setError('Could not reach the office. Check that the Go server is running.');
    };
  }, [clearMoves, clearServerError, markOut, remember]);

  const join = useCallback((name: string, avatar: number, customAvatar = '') => {
    // A join from the form is in the office once the server welcomes it. It
    // takes the office if no other tab holds it; otherwise it is a separate
    // session that joins fresh and waits for the office.
    markOut();
    const attempt = joinAttempt.current;
    setStatus('connecting');
    setError('');
    void claimOffice(false).then((held) => {
      if (joinAttempt.current === attempt) connect({ name, avatar, customAvatar }, held);
    });
  }, [connect, markOut]);

  useEffect(() => {
    const identity = savedIdentity();
    if (!identity) return;
    let live = true;
    restoring.current = true;
    // Only when no other tab of this browser holds the office.
    void claimOffice(false).then((held) => {
      if (!live || !restoring.current) return;
      restoring.current = false;
      if (!held) { setStatus('offline'); return; }
      inOffice.current = identity;
      connect(identity, true);
    });
    return () => { live = false; };
  }, [connect]);

  useEffect(() => () => {
    // Unmounting keeps the record and the lock: only leaving marks the person out.
    inOffice.current = null;
    clearTimeout(retryTimer.current);
    const current = socket.current;
    socket.current = null;
    current?.close();
    clearMoves();
    clearTimeout(serverErrorTimer.current);
  }, [clearMoves]);

  return { messages, players, selfId, status, error, serverError: serverError.message, serverErrorId: serverError.id, clearServerError, join, leave, send, move, cancelMove, serverNow, signalHandler };
}
