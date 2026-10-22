import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { MutableRefObject } from 'react';
import type { Player } from './world';
import type { Send, Signal } from './protocol';
import { createCameraBackground } from './cameraBackground';
import type { CameraBackground, CameraProcessor } from './cameraBackground';
import { createNoiseFilter, noiseFilterSupported } from './noiseFilter';
import type { NoiseFilter } from './noiseFilter';

// Off sends the microphone untouched, Standard uses the browser's built-in noise
// suppression, and Strong adds the RNNoise filter on top of it.
export type NoiseLevel = 'off' | 'standard' | 'strong';
type ActiveFilter = NoiseFilter & { source: MediaStreamTrack };

// A track with no built-in suppression to switch, such as one not from a device, rejects the constraint outright.
const canSuppress = (track: MediaStreamTrack) => !track.getCapabilities || !!track.getCapabilities().noiseSuppression?.includes(true);

type PeerStatus = 'connecting' | 'connected' | 'disconnected' | 'failed';
export type RemoteMedia = { stream: MediaStream; screenStream: MediaStream; status: PeerStatus };
type Peer = {
  id: string;
  sessionId: string;
  pc: RTCPeerConnection;
  stream: MediaStream;
  screenStream: MediaStream;
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
  const [screenStream, setScreenStream] = useState<MediaStream | null>(null);
  const [screenBusy, setScreenBusy] = useState(false);
  const screen = useRef<MediaStream | null>(null);
  const screenRequest = useRef(0);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [hasChosenDevices, setHasChosenDevices] = useState(false);
  const peers = useRef(new Map<string, Peer>());
  const local = useRef<MediaStream | null>(null);
  const capture = useRef<MediaStream | null>(null);
  const [noiseLevel, setNoiseLevel] = useState<NoiseLevel>('standard');
  const levelChoice = useRef<NoiseLevel>('standard');
  const levelRequest = useRef(0);
  const [levelBusy, setLevelBusy] = useState(false);
  const standardSupported = !!navigator.mediaDevices?.getSupportedConstraints().noiseSuppression;
  const strongSupported = noiseFilterSupported();
  const [noiseActive, setNoiseActive] = useState<boolean | undefined>(undefined);
  const [filtering, setFiltering] = useState(false);
  const filter = useRef<ActiveFilter | null>(null);
  const filterStarting = useRef<AbortController | null>(null);
  const processor = useRef<CameraProcessor | null>(null);
  const [background, setBackground] = useState<CameraBackground>('none');
  const backgroundChoice = useRef<CameraBackground>('none');
  const backgroundImage = useRef<File | undefined>(undefined);
  const processing = useRef<AbortController | null>(null);
  const context = useRef({ self, players });
  context.current = { self, players };
  const epoch = useRef(0);
  const request = useRef(0);
  const activeCarpet = self?.carpetId ?? '';
  const activeSelf = self?.id ?? '';

  const stopFilter = useCallback(() => {
    filterStarting.current?.abort(); filterStarting.current = null;
    filter.current?.stop(); filter.current = null;
  }, []);

  const stopCapture = useCallback(() => {
    processing.current?.abort(); processing.current = null;
    processor.current?.stop(); processor.current = null;
    stopFilter();
    capture.current?.getTracks().forEach((track) => track.stop()); capture.current = null;
    local.current?.getTracks().forEach((track) => track.stop());
    local.current = null;
    setLocalStream(null);
    setNoiseActive(undefined);
    setFiltering(false);
  }, [stopFilter]);

  const removePeer = useCallback((id: string) => {
    const peer = peers.current.get(id);
    if (!peer) return;
    peers.current.delete(id);
    peer.pc.ontrack = null;
    peer.pc.onconnectionstatechange = null;
    peer.pc.onicecandidate = null;
    peer.pc.close();
    peer.screenStream.getTracks().forEach((track) => track.stop());
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
    setRemoteMedia((current) => ({ ...current, [peer.id]: { stream: peer.stream, screenStream: peer.screenStream, status: 'failed' } }));
  }, []);

  const createPeer = useCallback((id: string, sessionId: string, offering = true): Peer => {
    const pc = new RTCPeerConnection(RTC_CONFIG);
    const stream = new MediaStream();
    const screenStream = new MediaStream();
    const peer: Peer = { id, sessionId, pc, stream, screenStream, candidates: [], queue: Promise.resolve() };
    peers.current.set(id, peer);
    // The answerer must use the transceivers created by setRemoteDescription.
    // Precreating its own would leave the offered sections receive-only.
    if (offering) {
      // Stable slots: microphone, camera, screen. Reserving the screen slot
      // lets either participant start sharing without renegotiation or glare.
      for (const [index, kind] of (['audio', 'video', 'video'] as const).entries()) {
        const track = index === 2 ? screen.current?.getVideoTracks()[0] : local.current?.getTracks().find((item) => item.kind === kind);
        const transceiver = pc.addTransceiver(track ?? kind, { direction: 'sendrecv' });
        const source = index === 2 ? screen.current : local.current;
        if (source) transceiver.sender.setStreams(source);
      }
    }
    setRemoteMedia((current) => ({ ...current, [id]: { stream, screenStream, status: 'connecting' } }));
    pc.onicecandidate = ({ candidate }) => {
      if (!candidate || candidate.type === 'relay' || peers.current.get(id) !== peer) return;
      send({ type: 'signal', to: id, sessionId, candidate: candidate.toJSON() });
    };
    pc.ontrack = ({ track, transceiver }) => {
      if (peers.current.get(id) !== peer) return;
      const destination = pc.getTransceivers().indexOf(transceiver) === 2 ? screenStream : stream;
      if (!destination.getTracks().some((item) => item.id === track.id)) destination.addTrack(track);
      setRemoteMedia((current) => ({ ...current, [id]: { stream, screenStream, status: pc.connectionState === 'connected' ? 'connected' : 'connecting' } }));
    };
    pc.onconnectionstatechange = () => {
      if (peers.current.get(id) !== peer) return;
      const state = pc.connectionState;
      const status: PeerStatus = state === 'connected' ? 'connected' : state === 'failed' ? 'failed' : state === 'disconnected' || state === 'closed' ? 'disconnected' : 'connecting';
      setRemoteMedia((current) => ({ ...current, [id]: { stream, screenStream, status } }));
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
          for (const [index, transceiver] of target.pc.getTransceivers().entries()) {
            transceiver.direction = 'sendrecv';
            const track = (index === 2 ? screen.current?.getVideoTracks()[0] : local.current?.getTracks().find((item) => item.kind === transceiver.receiver.track.kind)) ?? null;
            await transceiver.sender.replaceTrack(track);
            const source = index === 2 ? screen.current : local.current;
            if (source) transceiver.sender.setStreams(source);
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
    levelRequest.current += 1;
    stopCapture();
    setLevelBusy(false);
    setHasChosenDevices(false);
    setError('');
    setBusy(false);
    return () => {
      epoch.current += 1;
      request.current += 1;
      levelRequest.current += 1;
      processing.current?.abort(); processing.current = null;
      processor.current?.stop(); processor.current = null;
      stopFilter();
      capture.current?.getTracks().forEach((track) => track.stop()); capture.current = null;
      local.current?.getTracks().forEach((track) => track.stop());
      local.current = null;
    };
  }, [activeSelf, stopCapture, stopFilter]);

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
        peer.screenStream.getTracks().forEach((track) => track.stop());
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

  const publishCapture = useCallback((raw: MediaStream | null) => {
    capture.current = raw;
    const microphone = raw?.getAudioTracks().find((track) => track.readyState === 'live');
    // Built-in suppression is read from the capture track; the filter's output reports nothing.
    setNoiseActive(microphone?.getSettings().noiseSuppression);
    const filtered = filter.current && filter.current.source === microphone ? filter.current.track : null;
    setFiltering(!!filtered);
    const tracks = raw?.getTracks().map((track) => track.kind === 'video' && processor.current ? processor.current.track : track === microphone && filtered ? filtered : track) ?? [];
    const stream = tracks.length ? new MediaStream(tracks) : null;
    local.current = stream;
    setLocalStream(stream);
    send({ type: 'media',
      mic: stream?.getAudioTracks().some((track) => track.readyState === 'live') ?? false,
      screen: screen.current?.getVideoTracks().some((track) => track.readyState === 'live') ?? false,
      camera: stream?.getVideoTracks().some((track) => track.readyState === 'live') ?? false,
    });
  }, [send]);

  const syncSenders = useCallback(async () => {
    const tracks = local.current?.getTracks() ?? [];
    await Promise.all([...peers.current.values()].flatMap((peer) => (
      peer.pc.getTransceivers().map(async (transceiver, index) => {
        const track = (index === 2 ? screen.current?.getVideoTracks().find((item) => item.readyState === 'live') : tracks.find((item) => item.kind === transceiver.receiver.track.kind && item.readyState === 'live')) ?? null;
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

  const strongStopped = useCallback((message: string) => (
    `Strong noise filtering stopped. ${message} ${standardSupported ? 'Your microphone is using Standard noise suppression.' : 'Your microphone is being sent without noise suppression.'}`
  ), [standardSupported]);

  // Starts Strong on a live microphone track. Unlike a failed camera effect, which stops the
  // camera, a failed filter republishes the raw track at Standard so the participant stays audible.
  const startFilter = useCallback(async (source: MediaStreamTrack): Promise<ActiveFilter> => {
    const controller = new AbortController(); filterStarting.current = controller;
    let active: ActiveFilter | null = null;
    try {
      const started = await createNoiseFilter(source, (message) => {
        if (!active || filter.current !== active) return;
        filter.current = null;
        publishCapture(capture.current);
        void syncSenders();
        // A microphone that ended took the filter with it; there is nothing to fall back to.
        if (source.readyState !== 'live') return;
        levelChoice.current = 'standard'; setNoiseLevel('standard');
        setError(strongStopped(message));
      }, controller.signal);
      active = { ...started, source };
      return active;
    } finally { if (filterStarting.current === controller) filterStarting.current = null; }
  }, [publishCapture, strongStopped, syncSenders]);

  const stopScreen = useCallback(() => {
    screenRequest.current += 1;
    screen.current?.getTracks().forEach((track) => { track.onended = null; track.stop(); });
    screen.current = null;
    setScreenStream(null);
    setScreenBusy(false);
    publishCapture(capture.current);
    void syncSenders();
  }, [publishCapture, syncSenders]);

  useLayoutEffect(() => {
    stopScreen();
    return () => {
      screenRequest.current += 1;
      screen.current?.getTracks().forEach((track) => { track.onended = null; track.stop(); });
      screen.current = null;
    };
  }, [activeCarpet, activeSelf, stopScreen]);

  const startScreen = useCallback(async () => {
    const owner = context.current.self;
    if (!owner?.carpetId || screen.current) return;
    const requestId = ++screenRequest.current;
    const isCurrent = () => requestId === screenRequest.current && context.current.self?.id === owner.id && context.current.self?.carpetId === owner.carpetId;
    setScreenBusy(true);
    setError('');
    let acquired: MediaStream | null = null;
    try {
      if (!navigator.mediaDevices?.getDisplayMedia) throw new Error('Screen sharing requires a supported browser on localhost or HTTPS.');
      // Keep this call directly in the click handler's activation, before any await.
      acquired = await navigator.mediaDevices.getDisplayMedia({ video: { width: { ideal: 1920 }, height: { ideal: 1080 }, frameRate: { ideal: 15, max: 30 } }, audio: false });
      if (!isCurrent()) { acquired.getTracks().forEach((track) => track.stop()); return; }
      const track = acquired.getVideoTracks()[0];
      if (!track || track.readyState !== 'live') throw new Error('No screen was selected.');
      track.contentHint = 'detail';
      track.onended = stopScreen;
      screen.current = acquired;
      setScreenStream(acquired);
      publishCapture(capture.current);
      await syncSenders();
    } catch (failure) {
      acquired?.getTracks().forEach((track) => track.stop());
      if (isCurrent() && !(failure instanceof DOMException && failure.name === 'NotAllowedError')) {
        setError(failure instanceof Error ? failure.message : 'Could not share your screen.');
      }
    } finally {
      if (isCurrent()) setScreenBusy(false);
    }
  }, [publishCapture, stopScreen, syncSenders]);

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
      const retained = (capture.current?.getTracks() ?? []).filter((track) => {
        const wanted = track.kind === 'audio' ? mic : camera;
        if (!wanted) {
          if (track.kind === 'video') { processor.current?.stop(); processor.current = null; }
          // Stopped first, so the ending microphone is not reported as a filter failure.
          if (track.kind === 'audio') stopFilter();
          track.stop();
        }
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
          audio: needMic ? { echoCancellation: true, noiseSuppression: levelChoice.current !== 'off', autoGainControl: true } : false,
          video: needCamera ? { width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30, max: 30 } } : false,
        });
      }
      if (!isCurrent()) {
        acquired?.getTracks().forEach((track) => track.stop());
        return false;
      }

      const micTrack = acquired?.getAudioTracks()[0];
      if (micTrack && levelChoice.current === 'strong') {
        let next: ActiveFilter | null = null;
        try { next = await startFilter(micTrack); } catch (failure) {
          if (isCurrent()) {
            levelChoice.current = 'standard'; setNoiseLevel('standard');
            setError(strongStopped(failure instanceof Error ? failure.message : 'The noise filter could not start.'));
          }
        }
        if (!isCurrent()) { next?.stop(); acquired?.getTracks().forEach((track) => track.stop()); return false; }
        filter.current?.stop(); filter.current = next;
      }
      // The level may have changed while the microphone was opening; it is recorded, not applied, then.
      if (micTrack && filter.current?.source === micTrack && levelChoice.current !== 'strong') stopFilter();
      if (micTrack && standardSupported && canSuppress(micTrack) && micTrack.getConstraints().noiseSuppression !== (levelChoice.current !== 'off')) {
        await micTrack.applyConstraints({ ...micTrack.getConstraints(), noiseSuppression: levelChoice.current !== 'off' }).catch(() => {});
        if (!isCurrent()) { acquired?.getTracks().forEach((track) => track.stop()); return false; }
      }

      const cameraTrack = acquired?.getVideoTracks()[0];
      if (cameraTrack && backgroundChoice.current !== 'none') {
        const controller = new AbortController(); processing.current = controller;
        const next = await createCameraBackground(cameraTrack, backgroundChoice.current, (message) => {
          if (!capture.current?.getVideoTracks().includes(cameraTrack)) return;
          setError(`Camera background stopped. ${message}`);
          cameraTrack.stop(); processor.current?.stop(); processor.current = null;
          publishCapture(new MediaStream((capture.current?.getAudioTracks() ?? [])));
          void syncSenders();
        }, backgroundChoice.current === 'custom' ? backgroundImage.current : undefined, controller.signal);
        if (processing.current === controller) processing.current = null;
        if (!isCurrent()) { next.stop(); acquired?.getTracks().forEach((track) => track.stop()); return false; }
        processor.current = next;
      }
      const tracks = [...retained, ...(acquired?.getTracks() ?? [])].filter((track) => track.readyState === 'live');
      publishCapture(tracks.length ? new MediaStream(tracks) : null);
      await syncSenders();
      if (!isCurrent()) {
        // A later choice may have retained these same live tracks. Only release
        // newly acquired tracks which the current selection no longer owns.
        const currentTracks = capture.current?.getTracks() ?? [];
        acquired?.getTracks().forEach((track) => {
          if (!currentTracks.includes(track)) track.stop();
        });
        return false;
      }
      setHasChosenDevices(true);
      return true;
    } catch (failure) {
      if (filter.current && acquired?.getTracks().includes(filter.current.source)) stopFilter();
      acquired?.getTracks().forEach((track) => track.stop());
      if (isCurrent()) {
        // Permission failure for a new device must not disable an existing one.
        const remaining = capture.current?.getTracks().filter((track) => track.readyState === 'live') ?? [];
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
  }, [publishCapture, standardSupported, startFilter, stopFilter, strongStopped, syncSenders]);

  // The one way to change the noise level: the settings dialog uses it, and so can the app at
  // runtime, without a user gesture (#3 steps Strong down under device load through here).
  // With the microphone off it only records the choice. With it on, built-in suppression is
  // toggled on the live capture track and each sender's track is replaced in place, so nothing
  // is recaptured or renegotiated. Resolves to the level in effect afterwards.
  const chooseNoiseLevel = useCallback(async (level: NoiseLevel): Promise<NoiseLevel> => {
    if (level === 'strong' && !strongSupported) return levelChoice.current;
    const generation = epoch.current;
    const requestId = ++levelRequest.current;
    const track = capture.current?.getAudioTracks().find((item) => item.readyState === 'live');
    if (!track) {
      levelChoice.current = level; setNoiseLevel(level);
      return level;
    }
    filterStarting.current?.abort();
    const isLatest = () => generation === epoch.current && requestId === levelRequest.current;
    // A microphone turned off or reopened meanwhile makes this change stale too.
    const isCurrent = () => isLatest() && !!capture.current?.getAudioTracks().includes(track) && track.readyState === 'live';
    setLevelBusy(true); setError('');
    let next: ActiveFilter | null = null;
    try {
      // Preserves echo cancellation and gain control on the same capture track.
      if (standardSupported && canSuppress(track)) await track.applyConstraints({ ...track.getConstraints(), noiseSuppression: level !== 'off' });
      if (!isCurrent()) return levelChoice.current;
      const previous = filter.current;
      let stopped = '';
      if (level === 'strong' && previous?.source === track) next = previous;
      else if (level === 'strong') {
        try { next = await startFilter(track); } catch (failure) {
          stopped = failure instanceof Error ? failure.message : 'The noise filter could not start.';
        }
        if (!isCurrent()) { next?.stop(); return levelChoice.current; }
      }
      // The new track is ready before any sender changes, and the old filter stops only after.
      const effective: NoiseLevel = level === 'strong' && !next ? 'standard' : level;
      filter.current = next;
      levelChoice.current = effective; setNoiseLevel(effective);
      publishCapture(capture.current);
      await syncSenders();
      if (previous !== next) previous?.stop();
      if (stopped && isCurrent()) setError(strongStopped(stopped));
      return effective;
    } catch (failure) {
      if (next && next !== filter.current) next.stop();
      if (isCurrent()) setError(`Could not change noise suppression. ${failure instanceof Error ? failure.message : 'Please try again.'}`);
      return levelChoice.current;
    } finally { if (isLatest()) setLevelBusy(false); }
  }, [publishCapture, standardSupported, startFilter, strongStopped, strongSupported, syncSenders]);

  const chooseBackground = useCallback(async (choice: CameraBackground, image?: File) => {
    const generation = epoch.current;
    const requestId = ++request.current;
    const isCurrent = () => generation === epoch.current && requestId === request.current;
    setBusy(true); setError('');
    let next: CameraProcessor | null = null;
    try {
      if (image && (!['image/jpeg', 'image/png', 'image/webp'].includes(image.type) || image.size > 10 * 1024 * 1024)) throw new Error('Choose a JPG, PNG, or WebP image smaller than 10 MB.');
      const selectedImage = image ?? backgroundImage.current;
      const cameraTrack = capture.current?.getVideoTracks().find((track) => track.readyState === 'live');
      if (cameraTrack && choice !== 'none') {
        const controller = new AbortController(); processing.current = controller;
        next = await createCameraBackground(cameraTrack, choice, (message) => {
          if (!next || processor.current !== next) return;
          // A failed effect must not silently expose the real background.
          cameraTrack.stop(); processor.current?.stop(); processor.current = null;
          publishCapture(new MediaStream(capture.current?.getAudioTracks() ?? []));
          void syncSenders(); setError(`Camera background stopped. ${message}`);
        }, choice === 'custom' ? selectedImage : undefined, controller.signal);
        if (processing.current === controller) processing.current = null;
      }
      if (!isCurrent()) { next?.stop(); return; }
      if (image) backgroundImage.current = image;
      const previous = processor.current;
      processor.current = next;
      backgroundChoice.current = choice; setBackground(choice);
      publishCapture(capture.current);
      await syncSenders();
      previous?.stop();
    } catch (failure) {
      next?.stop();
      if (isCurrent()) setError(`Could not apply camera background. ${failure instanceof Error ? failure.message : 'Please try again.'}`);
    } finally { if (isCurrent()) setBusy(false); }
  }, [publishCapture, syncSenders]);

  return { noiseLevel, standardSupported, strongSupported, noiseActive, filtering, levelBusy, chooseNoiseLevel, background, chooseBackground, localStream, screenStream, screenBusy, startScreen, stopScreen, remoteMedia, chooseMedia, error, busy, hasChosenDevices };
}
