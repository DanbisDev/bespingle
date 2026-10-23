// One device-load monitor for the whole client. It reduces the browser's CPU
// pressure reports and the video encoders' own reports of what limits them to a
// few ordered levels. Anything may read or subscribe to the level; the media
// code only lends it the senders whose stats it polls.
export type LoadLevel = 'normal' | 'elevated' | 'heavy';
export const loadLevels: LoadLevel[] = ['normal', 'elevated', 'heavy'];
const worse = (a: LoadLevel, b: LoadLevel) => loadLevels.indexOf(a) >= loadLevels.indexOf(b) ? a : b;

// Structurally an RTCRtpSender, so this module needs no peer-connection code.
export type EncoderSource = { getStats(): Promise<RTCStatsReport>; getParameters(): { encodings?: { maxBitrate?: number }[] } };
// An encoder held to the bitrate cap the quality policy set reports a bandwidth
// limit for as long as the cap stands. Only a target well below the cap means
// the network is what limits it.
const ownCap = 0.8;

// The Compute Pressure API is Chromium only and not in TypeScript's DOM types.
type PressureRecord = { source: string; state: 'nominal' | 'fair' | 'serious' | 'critical' };
type PressureObserverLike = { observe(source: 'cpu', options?: { sampleInterval?: number }): Promise<void>; disconnect(): void };
type PressureObserverClass = new (callback: (records: PressureRecord[]) => void) => PressureObserverLike;

const pollInterval = 2000;
// A new stream is limited by bandwidth while the connection's estimate ramps
// up, and so is one whose cap was just raised. That is not load, so a stream is
// only judged once it has settled.
const warmUp = 10_000;

let pressure: LoadLevel = 'normal';
let encoder: LoadLevel = 'normal';
let level: LoadLevel = 'normal';
const listeners = new Set<(level: LoadLevel) => void>();
const providers = new Set<() => EncoderSource[]>();
let observer: PressureObserverLike | null = null;
let poller: ReturnType<typeof setInterval> | undefined;
let polling = false;

type StreamSample = { firstSeen?: number; frames: number; cap?: number; durations?: Record<string, number>; level: LoadLevel };
let samples = new WeakMap<EncoderSource, Map<string, StreamSample>>();

function publish() {
  const next = worse(pressure, encoder);
  if (next === level) return;
  level = next;
  for (const listener of [...listeners]) listener(level);
}

export function currentLoad(): LoadLevel { return level; }

// Starts the monitor with its first subscriber and stops it with its last.
export function subscribeLoad(listener: (level: LoadLevel) => void): () => void {
  listeners.add(listener);
  if (listeners.size === 1) start();
  return () => {
    if (!listeners.delete(listener) || listeners.size) return;
    stop();
  };
}

// Lends the monitor a way to find the outgoing video senders. It is called on
// every poll, so it always sees the current connections.
export function watchEncoders(provider: () => EncoderSource[]): () => void {
  providers.add(provider);
  return () => { providers.delete(provider); };
}

function start() {
  const Observer = (globalThis as { PressureObserver?: PressureObserverClass }).PressureObserver;
  if (Observer) {
    try {
      const created = new Observer((records) => {
        const state = records.filter((record) => record.source === 'cpu').at(-1)?.state;
        if (!state || observer !== created) return;
        pressure = state === 'serious' || state === 'critical' ? 'heavy' : state === 'fair' ? 'elevated' : 'normal';
        publish();
      });
      observer = created;
      // A permissions policy or an unsupported source rejects here. The encoder
      // reports remain, as in browsers without the API.
      created.observe('cpu', { sampleInterval: pollInterval }).catch(() => {
        if (observer === created) { observer = null; pressure = 'normal'; publish(); }
      });
    } catch { observer = null; }
  }
  poller = setInterval(() => { void poll(); }, pollInterval);
}

function stop() {
  observer?.disconnect();
  observer = null;
  clearInterval(poller);
  poller = undefined;
  samples = new WeakMap();
  pressure = 'normal';
  encoder = 'normal';
  publish();
}

// The worst outgoing stream decides: with one connection per peer, every
// stream shares the same processor and the same upload.
async function poll() {
  if (polling) return;
  polling = true;
  try {
    const sources = [...providers].flatMap((provider) => provider());
    const levels = await Promise.all(sources.map(judge));
    if (!poller) return;
    encoder = levels.reduce(worse, 'normal');
    publish();
  } finally { polling = false; }
}

async function judge(source: EncoderSource): Promise<LoadLevel> {
  let report: RTCStatsReport;
  try { report = await source.getStats(); } catch { return 'normal'; }
  const now = performance.now();
  const streams = samples.get(source) ?? new Map<string, StreamSample>();
  samples.set(source, streams);
  let cap: number | undefined;
  try { cap = source.getParameters().encodings?.[0]?.maxBitrate; } catch { cap = undefined; }
  let result: LoadLevel = 'normal';
  for (const row of report.values()) {
    if (row.type !== 'outbound-rtp' || row.kind !== 'video') continue;
    const frames = row.framesEncoded ?? 0;
    const durations = row.qualityLimitationDurations as Record<string, number> | undefined;
    const previous = streams.get(row.id);
    const settled = previous?.cap === cap ? previous?.firstSeen : undefined;
    const firstSeen = settled ?? (frames > 0 ? now : undefined);
    // While a stream settles after a cap change it neither confirms the load
    // that caused the change nor reports the relief before the change has
    // taken effect, so heavy load reads as elevated until then.
    const unsettled: LoadLevel = previous?.level === 'heavy' ? 'elevated' : previous?.level ?? 'normal';
    const sample: StreamSample = { firstSeen, frames, cap, durations, level: unsettled };
    streams.set(row.id, sample);
    // Only a stream that encoded since the last poll reports anything current.
    if (!previous || frames <= previous.frames) { sample.level = 'normal'; continue; }
    if (firstSeen === undefined || now - firstSeen < warmUp) { result = worse(result, unsettled); continue; }
    // The share of the last interval spent limited by CPU or bandwidth. Firefox
    // and older engines give only the current reason.
    const network = !(cap && row.targetBitrate >= cap * ownCap);
    let limited: number;
    if (durations && previous.durations) {
      const spent = (key: string) => Math.max(0, (durations[key] ?? 0) - (previous.durations?.[key] ?? 0));
      const total = Object.keys(durations).reduce((sum, key) => sum + spent(key), 0);
      limited = total > 0 ? (spent('cpu') + (network ? spent('bandwidth') : 0)) / total : 0;
    } else {
      limited = row.qualityLimitationReason === 'cpu' || (network && row.qualityLimitationReason === 'bandwidth') ? 1 : 0;
    }
    sample.level = limited >= 0.5 ? 'heavy' : limited >= 0.1 ? 'elevated' : 'normal';
    result = worse(result, sample.level);
  }
  return result;
}
