export type VideoQuality = 'auto' | 'high' | 'low' | 'audio';
export const videoQualities: { id: VideoQuality; label: string; detail: string }[] = [
  { id: 'auto', label: 'Auto', detail: 'Lowers your video as the conversation grows' },
  { id: 'high', label: 'High', detail: 'Always send full quality' },
  { id: 'low', label: 'Low', detail: 'Always send reduced quality' },
  { id: 'audio', label: 'Audio only', detail: 'Others see your avatar instead of your camera' },
];

// Upper bounds for one outgoing video. They become sender encoding parameters,
// which never renegotiate the connection.
export type VideoCap = { width: number; height: number; frameRate: number; maxBitrate: number };
// `active: false` stops sending. A missing cap sends the track as captured.
export type SenderTarget = { active: boolean; cap?: VideoCap };
export type QualityTarget = { camera: SenderTarget; screen: SenderTarget };
export type QualityInput = {
  // Everyone on your carpet, including you. Every client sees the same count.
  participants: number;
  quality: VideoQuality;
  // How many rungs further down the ladder to go than the count alone sets.
  loadSteps: number;
};

// One ordered ladder, highest quality first. Stepping down walks the camera
// rungs, then (later) background filter rungs, then screen-share rungs. New
// rungs are inserted in their section without reordering the others.
export type Rung = { kind: 'camera'; cap: VideoCap } | { kind: 'screen'; cap: VideoCap };
export const ladder: Rung[] = [
  { kind: 'camera', cap: { width: 1280, height: 720, frameRate: 30, maxBitrate: 2_500_000 } },
  { kind: 'camera', cap: { width: 960, height: 540, frameRate: 24, maxBitrate: 1_200_000 } },
  { kind: 'camera', cap: { width: 640, height: 360, frameRate: 15, maxBitrate: 500_000 } },
  // Background filter rungs (#3) go here, then screen-share rungs (load follow-up).
];

const cameraRungs = ladder.flatMap((rung, index) => rung.kind === 'camera' ? [index] : []);
const lowestCamera = cameraRungs[cameraRungs.length - 1];

function countRung(participants: number) {
  return participants >= 6 ? cameraRungs[2] : participants >= 4 ? cameraRungs[1] : cameraRungs[0];
}

export function qualityTarget({ participants, quality, loadSteps }: QualityInput): QualityTarget {
  // Manual choices fix quality: they ignore count and load entirely.
  if (quality === 'audio') return { camera: { active: false }, screen: { active: true } };
  const start = quality === 'high' ? cameraRungs[0] : quality === 'low' ? lowestCamera : countRung(participants);
  const position = quality === 'auto' ? Math.min(ladder.length - 1, start + Math.max(0, Math.floor(loadSteps))) : start;
  // Past a section, that section stays at its lowest rung; before it, at full quality.
  const reached = ladder.slice(0, position + 1).reverse();
  const camera = reached.find((rung) => rung.kind === 'camera');
  const screen = reached.find((rung) => rung.kind === 'screen');
  return { camera: { active: true, cap: camera?.cap }, screen: { active: true, cap: screen?.cap } };
}

// Turns a cap into encoding parameters for a track of the given size. The
// camera may not be 1280×720, and background processing produces its own track.
export function encodingFor(target: SenderTarget, size: { width?: number; height?: number } | undefined): Partial<RTCRtpEncodingParameters> {
  if (!target.cap) return { active: target.active, scaleResolutionDownBy: 1, maxFramerate: undefined, maxBitrate: undefined };
  const { width, height, frameRate, maxBitrate } = target.cap;
  // Without a known size assume the requested 720p capture.
  const scale = Math.max(1, (size?.width || 1280) / width, (size?.height || 720) / height);
  return { active: target.active, scaleResolutionDownBy: scale, maxFramerate: frameRate, maxBitrate };
}

const storageKey = 'bespingle_video_quality';
export function readVideoQuality(): VideoQuality {
  try {
    const value = localStorage.getItem(storageKey);
    return videoQualities.some((item) => item.id === value) ? value as VideoQuality : 'auto';
  } catch { return 'auto'; }
}
export function saveVideoQuality(quality: VideoQuality) {
  try { localStorage.setItem(storageKey, quality); } catch { /* Private modes may refuse storage. */ }
}
