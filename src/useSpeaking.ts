import { useEffect, useState } from 'react';

// Keep the border steady through the small pauses between words.
const RELEASE_MS = 300;

export function useSpeaking(stream: MediaStream | null, enabled: boolean) {
  const [speaking, setSpeaking] = useState(false);

  useEffect(() => {
    setSpeaking(false);
    if (!stream || !enabled || typeof AudioContext === 'undefined') return;

    let context: AudioContext | undefined;
    let source: MediaStreamAudioSourceNode | undefined;
    let timer: ReturnType<typeof setInterval> | undefined;
    let active = false;
    const update = (next: boolean) => {
      if (active === next) return;
      active = next;
      setSpeaking(next);
    };
    const disconnect = () => {
      clearInterval(timer);
      source?.disconnect();
      source = undefined;
      if (context) void context.close().catch(() => {});
      context = undefined;
      update(false);
    };
    const resume = () => {
      if (context?.state === 'suspended') void context.resume().catch(() => {});
    };
    const monitor = () => {
      disconnect();
      const track = stream.getAudioTracks().find((item) => item.readyState === 'live');
      if (!track) return;
      try {
        context = new AudioContext();
        const analyser = context.createAnalyser();
        analyser.fftSize = 1024;
        // An audio-only stream also handles tracks added after the peer connects.
        source = context.createMediaStreamSource(new MediaStream([track]));
        source.connect(analyser);
        // No destination connection: detection must never play the local mic.
        const samples = new Float32Array(analyser.fftSize);
        let lastVoice = -Infinity;
        resume();
        timer = setInterval(() => {
          if (!track.enabled || track.muted || track.readyState !== 'live' || context?.state !== 'running') {
            lastVoice = -Infinity;
            update(false);
            return;
          }
          analyser.getFloatTimeDomainData(samples);
          let energy = 0;
          for (const sample of samples) energy += sample * sample;
          const level = Math.sqrt(energy / samples.length);
          const now = performance.now();
          if (level > (active ? 0.015 : 0.025)) lastVoice = now;
          update(now - lastVoice < RELEASE_MS);
        }, 50);
      } catch {
        // Highlighting is optional; unavailable audio analysis must not break a call.
        disconnect();
      }
    };

    monitor();
    stream.addEventListener('addtrack', monitor);
    stream.addEventListener('removetrack', monitor);
    window.addEventListener('pointerdown', resume);
    window.addEventListener('keydown', resume);
    return () => {
      stream.removeEventListener('addtrack', monitor);
      stream.removeEventListener('removetrack', monitor);
      window.removeEventListener('pointerdown', resume);
      window.removeEventListener('keydown', resume);
      disconnect();
    };
  }, [stream, enabled]);

  return enabled && speaking;
}
