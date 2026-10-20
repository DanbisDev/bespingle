import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { MutableRefObject } from 'react';
import type { Player } from './world';
import type { Send, Signal } from './protocol';

type PeerStatus = 'connecting' | 'connected' | 'disconnected' | 'failed';
export type RemoteMedia = { stream: MediaStream; status: PeerStatus };
type Peer = {
  id: string;
  sessionId: string;
  pc: RTCPeerConnection;
  stream: MediaStream;
  candidates: RTCIceCandidateInit[];
  queue: Promise<void>;
};

// Discovery only. There are deliberately no TURN URLs or server media endpoints.
const RTC_CONFIG: RTCConfiguration = {
  iceServers: [{ urls: 'stun:stun.cloudflare.com:3478' }],
};

export function usePeerMedia(
  self: Player | undefined,
  players: Player[],
  send: Send,
  signalHandler: MutableRefObject<(signal: Signal) => void>,
) {
  const [localStream, setLocalStream] = useState<MediaStream | null>(null);
  const [remoteMedia, setRemoteMedia] = useState<Record<string, RemoteMedia>>({});
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [hasChosenDevices, setHasChosenDevices] = useState(false);
  const peers = useRef(new Map<string, Peer>());
  const local = useRef<MediaStream | null>(null);
  const context = useRef({ self, players });
  context.current = { self, players };
  const epoch = useRef(0);
  const request = useRef(0);
  const activeCarpet = self?.carpetId ?? '';
  const activeSelf = self?.id ?? '';

  const stopCapture = useCallback(() => {
    local.current?.getTracks().forEach((track) => track.stop());
    local.current = null;
    setLocalStream(null);
  }, []);

  const removePeer = useCallback((id: string) => {
    const peer = peers.current.get(id);
    if (!peer) return;
    peers.current.delete(id);
    peer.pc.ontrack = null;
    peer.pc.onconnectionstatechange = null;
    peer.pc.onicecandidate = null;
    peer.pc.close();
    peer.stream.getTracks().forEach((track) => track.stop());
    setRemoteMedia((current) => {
      if (!current[id]) return current;
      const next = { ...current };
      delete next[id];
      return next;
    });
  }, []);

  const reportFailure = useCallback((peer: Peer, failure: unknown) => {
    if (peers.current.get(peer.id) !== peer) return;
    console.warn('Direct peer connection:', failure);
    setRemoteMedia((current) => ({ ...current, [peer.id]: { stream: peer.stream, status: 'failed' } }));
  }, []);

  const createPeer = useCallback((id: string, sessionId: string, offering = true): Peer => {
    const pc = new RTCPeerConnection(RTC_CONFIG);
    const stream = new MediaStream();
    const peer: Peer = { id, sessionId, pc, stream, candidates: [], queue: Promise.resolve() };
    peers.current.set(id, peer);
    // The answerer must use the transceivers created by setRemoteDescription.
    // Precreating its own would leave the offered sections receive-only.
    if (offering) {
      for (const kind of ['audio', 'video'] as const) {
        const track = local.current?.getTracks().find((item) => item.kind === kind);
        const transceiver = pc.addTransceiver(track ?? kind, { direction: 'sendrecv' });
        if (local.current) transceiver.sender.setStreams(local.current);
      }
    }
    setRemoteMedia((current) => ({ ...current, [id]: { stream, status: 'connecting' } }));
    pc.onicecandidate = ({ candidate }) => {
      if (!candidate || candidate.type === 'relay' || peers.current.get(id) !== peer) return;
      send({ type: 'signal', to: id, sessionId, candidate: candidate.toJSON() });
    };
    pc.ontrack = ({ track }) => {
      if (peers.current.get(id) !== peer) return;
      if (!stream.getTracks().some((item) => item.id === track.id)) stream.addTrack(track);
      setRemoteMedia((current) => ({ ...current, [id]: { stream, status: pc.connectionState === 'connected' ? 'connected' : 'connecting' } }));
    };
    pc.onconnectionstatechange = () => {
      if (peers.current.get(id) !== peer) return;
      const state = pc.connectionState;
      const status: PeerStatus = state === 'connected' ? 'connected' : state === 'failed' ? 'failed' : state === 'disconnected' || state === 'closed' ? 'disconnected' : 'connecting';
      setRemoteMedia((current) => ({ ...current, [id]: { stream, status } }));
    };
    return peer;
  }, [send]);

  const receiveSignal = useCallback((signal: Signal) => {
    const { self: currentSelf, players: currentPlayers } = context.current;
    const from = signal.from;
    if (!currentSelf?.carpetId || !from || signal.to !== currentSelf.id) return;
    const remote = currentPlayers.find((player) => player.id === from);
    if (!remote || remote.carpetId !== currentSelf.carpetId) return;
    let peer = peers.current.get(from);
    if (signal.description?.type === 'offer') {
      // Exactly one caller per pair avoids simultaneous offers (glare).
      if (from >= currentSelf.id) return;
      if (peer && peer.sessionId !== signal.sessionId) {
        removePeer(from);
        peer = undefined;
      }
      peer ??= createPeer(from, signal.sessionId, false);
    }
    if (!peer || peer.sessionId !== signal.sessionId) return;
    const target = peer;
    target.queue = target.queue.then(async () => {
      if (peers.current.get(from) !== target) return;
      if (signal.description) {
        await target.pc.setRemoteDescription(signal.description);
        for (const candidate of target.candidates.splice(0)) await target.pc.addIceCandidate(candidate);
        if (signal.description.type === 'offer') {
          for (const transceiver of target.pc.getTransceivers()) {
            transceiver.direction = 'sendrecv';
            const track = local.current?.getTracks().find((item) => item.kind === transceiver.receiver.track.kind) ?? null;
            await transceiver.sender.replaceTrack(track);
            if (local.current) transceiver.sender.setStreams(local.current);
          }
          const answer = await target.pc.createAnswer();
          await target.pc.setLocalDescription(answer);
          if (peers.current.get(from) === target) {
            send({ type: 'signal', to: from, sessionId: target.sessionId, description: target.pc.localDescription!.toJSON() });
          }
        }
      } else if (signal.candidate) {
        if (signal.candidate.candidate?.includes(' typ relay ')) return;
        if (target.pc.remoteDescription) await target.pc.addIceCandidate(signal.candidate);
        else target.candidates.push(signal.candidate);
      }
    }).catch((failure) => reportFailure(target, failure));
  }, [createPeer, removePeer, reportFailure, send]);

  useLayoutEffect(() => {
    signalHandler.current = receiveSignal;
    return () => { signalHandler.current = () => {}; };
  }, [receiveSignal, signalHandler]);

  // Capture belongs to the game session, not the current conversation carpet.
  useLayoutEffect(() => {
    epoch.current += 1;
    request.current += 1;
    stopCapture();
    setHasChosenDevices(false);
    setError('');
    setBusy(false);
    return () => {
      epoch.current += 1;
      request.current += 1;
      local.current?.getTracks().forEach((track) => track.stop());
      local.current = null;
    };
  }, [activeSelf, stopCapture]);

  // Only peer connections belong to a carpet. No media is sent on the open floor.
  useLayoutEffect(() => {
    for (const id of peers.current.keys()) removePeer(id);
    setRemoteMedia({});
    return () => {
      for (const peer of peers.current.values()) {
        peer.pc.ontrack = null;
        peer.pc.onconnectionstatechange = null;
        peer.pc.onicecandidate = null;
        peer.pc.close();
        peer.stream.getTracks().forEach((track) => track.stop());
      }
      peers.current.clear();
    };
  }, [activeCarpet, activeSelf, removePeer]);

  useEffect(() => {
    if (!self?.carpetId) return;
    const members = players.filter((player) => player.id !== self.id && player.carpetId === self.carpetId);
    for (const id of peers.current.keys()) {
      if (!members.some((member) => member.id === id)) removePeer(id);
    }
    for (const member of members) {
      if (self.id >= member.id || peers.current.has(member.id)) continue;
      const peer = createPeer(member.id, crypto.randomUUID());
      peer.queue = peer.queue.then(async () => {
        const offer = await peer.pc.createOffer();
        await peer.pc.setLocalDescription(offer);
        if (peers.current.get(member.id) !== peer) return;
        send({ type: 'signal', to: member.id, sessionId: peer.sessionId, description: peer.pc.localDescription!.toJSON() });
      }).catch((failure) => reportFailure(peer, failure));
    }
  }, [players, self, createPeer, removePeer, reportFailure, send]);

  const publishCapture = useCallback((stream: MediaStream | null) => {
    local.current = stream;
    setLocalStream(stream);
    send({ type: 'media',
      mic: stream?.getAudioTracks().some((track) => track.readyState === 'live') ?? false,
      camera: stream?.getVideoTracks().some((track) => track.readyState === 'live') ?? false,
    });
  }, [send]);

  const syncSenders = useCallback(async () => {
    const tracks = local.current?.getTracks() ?? [];
    await Promise.all([...peers.current.values()].flatMap((peer) => (
      peer.pc.getTransceivers().map(async (transceiver) => {
        const track = tracks.find((item) => item.kind === transceiver.receiver.track.kind && item.readyState === 'live') ?? null;
        try {
          await transceiver.sender.replaceTrack(track);
        } catch (failure) {
          // A carpet change can close a peer while its sender is being updated.
          // Capture must remain enabled independently of any individual peer.
          reportFailure(peer, failure);
        }
      })
    )));
  }, [reportFailure]);

  const chooseMedia = useCallback(async (mic: boolean, camera: boolean): Promise<boolean> => {
    const playerId = context.current.self?.id;
    if (!playerId) return false;
    const generation = epoch.current;
    const requestId = ++request.current;
    const isCurrent = () => generation === epoch.current && requestId === request.current && context.current.self?.id === playerId;
    setBusy(true);
    setError('');
    let acquired: MediaStream | null = null;
    try {
      // Reuse each enabled device's live track. Toggling the other device must
      // not reopen or interrupt it, and explicitly disabled tracks stop now.
      const retained = (local.current?.getTracks() ?? []).filter((track) => {
        const wanted = track.kind === 'audio' ? mic : camera;
        if (!wanted) track.stop();
        return wanted && track.readyState === 'live';
      });
      publishCapture(retained.length ? new MediaStream(retained) : null);
      await syncSenders();
      if (!isCurrent()) return false;

      const needMic = mic && !retained.some((track) => track.kind === 'audio');
      const needCamera = camera && !retained.some((track) => track.kind === 'video');
      if (needMic || needCamera) {
        if (!navigator.mediaDevices?.getUserMedia) throw new Error('Camera and microphone require localhost or HTTPS.');
        acquired = await navigator.mediaDevices.getUserMedia({
          audio: needMic ? { echoCancellation: true, noiseSuppression: true, autoGainControl: true } : false,
          video: needCamera ? { width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30, max: 30 } } : false,
        });
      }
      if (!isCurrent()) {
        acquired?.getTracks().forEach((track) => track.stop());
        return false;
      }

      const tracks = [...retained, ...(acquired?.getTracks() ?? [])].filter((track) => track.readyState === 'live');
      publishCapture(tracks.length ? new MediaStream(tracks) : null);
      await syncSenders();
      if (!isCurrent()) {
        // A later choice may have retained these same live tracks. Only release
        // newly acquired tracks which the current selection no longer owns.
        const currentTracks = local.current?.getTracks() ?? [];
        acquired?.getTracks().forEach((track) => {
          if (!currentTracks.includes(track)) track.stop();
        });
        return false;
      }
      setHasChosenDevices(true);
      return true;
    } catch (failure) {
      acquired?.getTracks().forEach((track) => track.stop());
      if (isCurrent()) {
        // Permission failure for a new device must not disable an existing one.
        const remaining = local.current?.getTracks().filter((track) => track.readyState === 'live') ?? [];
        publishCapture(remaining.length ? new MediaStream(remaining) : null);
        await syncSenders();
        if (!isCurrent()) return false;
        const detail = failure instanceof Error ? failure.message : 'The device could not be opened.';
        setError(`Could not enable the requested devices. ${detail}`);
      }
      return false;
    } finally {
      if (isCurrent()) setBusy(false);
    }
  }, [publishCapture, syncSenders]);

  return { localStream, remoteMedia, chooseMedia, error, busy, hasChosenDevices };
}
