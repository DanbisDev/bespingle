// Browser checks for the RNNoise filter in src/noiseFilter.ts, run by test:audio.
// They load the module from the dev server and from a production build of it.
import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import { mkdir, readFile, readdir, writeFile, access } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { build, preview } from 'vite';

const root = fileURLToPath(new URL('../', import.meta.url));
const RATE = 48000;

// Public-domain recordings of speech, typing and kitchen clatter (see fixtures/noise-filter/NOTICE.txt).
async function decode(names) {
  const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || undefined, headless: true, args: ['--no-sandbox'] });
  try {
    const page = await browser.newPage();
    const clips = {};
    for (const name of names) {
      const data = (await readFile(join(root, `scripts/fixtures/noise-filter/${name}.webm`))).toString('base64');
      clips[name] = fromBase64(await page.evaluate(async (data) => {
        const bytes = Uint8Array.from(atob(data), (c) => c.charCodeAt(0));
        const samples = (await new OfflineAudioContext(1, 1, 48000).decodeAudioData(bytes.buffer)).getChannelData(0);
        const view = new Uint8Array(samples.buffer); let text = '';
        for (let i = 0; i < view.length; i += 0x8000) text += String.fromCharCode(...view.subarray(i, i + 0x8000));
        return btoa(text);
      }, data));
    }
    return clips;
  } finally { await browser.close(); }
}
const rms = (samples) => Math.sqrt(samples.reduce((sum, value) => sum + value * value, 0) / samples.length);
const level = (samples, decibels) => { const gain = 10 ** (decibels / 20) / rms(samples); return samples.map((value) => value * gain); };
// Voice at -20 dBFS; noise 10 dB quieter, as typing on the same desk would be.
const SEGMENTS = [
  { kind: 'voice', from: 0, to: 3, voice: [0, 3] }, // Lets RNNoise settle before anything is measured.
  { kind: 'keyboard', from: 3, to: 7, noise: ['keyboard', 0] },
  { kind: 'voice', from: 7, to: 10, voice: [3, 6] },
  { kind: 'kitchen', from: 10, to: 14, noise: ['kitchen', 0] },
  { kind: 'voice and keyboard', from: 14, to: 16, voice: [6, 8], noise: ['keyboard', 3] },
];
function mixture({ voice, keyboard, kitchen }) {
  const clips = { voice: level(voice, -20), keyboard: level(keyboard, -30), kitchen: level(kitchen, -30) };
  const samples = new Float32Array(16 * RATE);
  const clean = new Float32Array(16 * RATE);
  for (const segment of SEGMENTS) {
    const at = segment.from * RATE; const length = (segment.to - segment.from) * RATE;
    if (segment.voice) { const part = clips.voice.subarray(segment.voice[0] * RATE, segment.voice[0] * RATE + length); samples.set(part, at); clean.set(part, at); }
    if (segment.noise) { const [name, offset] = segment.noise; clips[name].subarray(offset * RATE, offset * RATE + length).forEach((value, i) => { samples[at + i] += value; }); }
  }
  return { samples, clean, voice: clips.voice };
}
function wav(samples) {
  const data = Buffer.alloc(samples.length * 2);
  samples.forEach((value, i) => data.writeInt16LE(Math.round(Math.max(-1, Math.min(1, value)) * 32767), i * 2));
  const header = Buffer.alloc(44);
  header.write('RIFF', 0); header.writeUInt32LE(36 + data.length, 4); header.write('WAVEfmt ', 8);
  header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20); header.writeUInt16LE(1, 22);
  header.writeUInt32LE(RATE, 24); header.writeUInt32LE(RATE * 2, 28); header.writeUInt16LE(2, 32); header.writeUInt16LE(16, 34);
  header.write('data', 36); header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]);
}
const toBase64 = (array) => Buffer.from(array.buffer, array.byteOffset, array.byteLength).toString('base64');
const fromBase64 = (text) => new Float32Array(new Uint8Array(Buffer.from(text, 'base64')).buffer);

// 10 ms energy frames, used to line recordings up with each other.
const frames = (samples) => Array.from({ length: Math.floor(samples.length / 480) }, (_, n) => {
  let sum = 0; for (let i = n * 480; i < (n + 1) * 480; i++) sum += samples[i] ** 2; return Math.sqrt(sum / 480);
});
function lag(reference, signal, maximum) {
  let best = 0; let bestScore = -Infinity;
  for (let shift = 0; shift <= maximum; shift++) {
    let score = 0; for (let n = 0; n + shift < signal.length && n < reference.length; n++) score += reference[n] * signal[n + shift];
    if (score > bestScore) { bestScore = score; best = shift; }
  }
  return best * 480;
}
// Delay to the sample, so a bypass that skipped or repeated audio would show.
function exactLag(raw, filtered, from, to, around) {
  let best = 0; let bestScore = -Infinity;
  for (let shift = Math.max(0, around - 960); shift <= around + 960; shift++) {
    let score = 0; for (let i = from; i < to; i++) score += raw[i] * filtered[i + shift];
    if (score > bestScore) { bestScore = score; best = shift; }
  }
  return best;
}
const energy = (samples, from, to) => { let sum = 0; for (let i = from; i < to; i++) sum += samples[i] ** 2; return sum; };
const decibels = (ratio) => 10 * Math.log10(ratio);

const cache = join(root, '.cache');
await mkdir(cache, { recursive: true });
const { samples: signal, clean, voice } = mixture(await decode(['voice', 'keyboard', 'kitchen']));
const microphoneFile = join(cache, 'noise-filter-voice.wav');
await writeFile(microphoneFile, wav(voice));

// A production build that includes the filter, served from its own origin.
const outDir = join(cache, 'noise-filter-build');
await build({ root, logLevel: 'warn', build: { outDir, emptyOutDir: true, manifest: true, rollupOptions: { input: { index: join(root, 'index.html'), noiseFilter: join(root, 'src/noiseFilter.ts') }, preserveEntrySignatures: 'exports-only' } } });
const manifest = JSON.parse(await readFile(join(outDir, '.vite/manifest.json'), 'utf8'));
const builtFiles = await readdir(join(outDir, 'assets'));
assert(builtFiles.some((file) => /noiseFilter\.worklet.*\.js$/.test(file)), `Build emits the worklet: ${builtFiles}`);
assert(builtFiles.some((file) => /rnnoise-.*\.wasm$/.test(file)) && builtFiles.some((file) => /rnnoise_simd-.*\.wasm$/.test(file)), `Build emits the WebAssembly binaries: ${builtFiles}`);
await access(join(outDir, 'audio/NOTICE.txt'));
await access(join(outDir, 'audio/RNNOISE-LICENSE.txt'));
await access(join(outDir, 'audio/RNNOISE-WASM-LICENSE.txt'));
const server = await preview({ root, logLevel: 'warn', build: { outDir }, preview: { host: '127.0.0.1', port: 5560 } });
const origins = [
  { label: 'dev server', origin: new URL(process.env.BESPINGLE_URL || 'http://127.0.0.1:5555').origin, module: '/src/noiseFilter.ts' },
  { label: 'production build', origin: new URL(server.resolvedUrls.local[0]).origin, module: `/${manifest['src/noiseFilter.ts'].file}` },
];

const browser = await chromium.launch({
  executablePath: process.env.CHROME_PATH || undefined,
  headless: true,
  args: ['--no-sandbox', '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', `--use-file-for-fake-audio-capture=${microphoneFile}`],
});
try {
  for (const { label, origin, module } of origins) {
    const context = await browser.newContext({ permissions: ['microphone'] });
    await context.addInitScript(() => {
      window.__contexts = [];
      const NativeContext = window.AudioContext;
      window.AudioContext = class extends NativeContext {
        constructor(...args) {
          super(...args); window.__contexts.push(this);
          if (window.__holdSuspended) { this.resume = () => new Promise(() => {}); void this.suspend(); }
        }
      };
      window.__nodes = [];
      const NativeNode = window.AudioWorkletNode;
      window.AudioWorkletNode = class extends NativeNode {
        constructor(context, name, options) {
          if (window.__corruptWasm) options = { ...options, processorOptions: { wasm: new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0, 1]).buffer } };
          super(context, name, options); window.__nodes.push(this); this.__options = options;
        }
      };
      window.__worklets = [];
      const addModule = AudioWorklet.prototype.addModule;
      AudioWorklet.prototype.addModule = function (url, ...rest) { window.__worklets.push(new URL(url, location.href).href); return addModule.call(this, url, ...rest); };
    });
    const page = await context.newPage();
    const errors = [];
    const foreign = [];
    page.on('pageerror', (error) => errors.push(error.message));
    page.on('request', (request) => { if (!request.url().startsWith(origin) && !/^(data|blob):/.test(request.url())) foreign.push(request.url()); });
    const notice = await page.goto(`${origin}/audio/NOTICE.txt`);
    assert(notice.ok() && (await notice.text()).includes('RNNoise'), `${label} serves the licence notice`);

    // Starts on the fake microphone and passes its voice through.
    const flow = await page.evaluate(async (module) => {
      const { createNoiseFilter, noiseFilterSupported } = await import(module);
      const mic = (await navigator.mediaDevices.getUserMedia({ audio: true })).getAudioTracks()[0];
      const failures = [];
      const filter = await createNoiseFilter(mic, (message) => failures.push(message));
      const meter = new AudioContext();
      const level = (track) => { const analyser = meter.createAnalyser(); analyser.fftSize = 2048; meter.createMediaStreamSource(new MediaStream([track])).connect(analyser); return analyser; };
      const raw = level(mic); const filtered = level(filter.track);
      const peaks = { raw: 0, filtered: 0 };
      const data = new Float32Array(2048);
      for (let n = 0; n < 40; n++) {
        await new Promise((resolve) => setTimeout(resolve, 50));
        for (const [key, analyser] of [['raw', raw], ['filtered', filtered]]) {
          analyser.getFloatTimeDomainData(data);
          peaks[key] = Math.max(peaks[key], Math.sqrt(data.reduce((sum, value) => sum + value * value, 0) / data.length));
        }
      }
      const result = { supported: noiseFilterSupported(), state: filter.track.readyState, kind: filter.track.kind, channels: filter.track.getSettings().channelCount, peaks, failures, distinct: filter.track.id !== mic.id };
      filter.stop(); await meter.close(); mic.stop();
      return result;
    }, module);
    assert(flow.supported, `${label}: supported in Chromium`);
    assert.equal(flow.state, 'live'); assert.equal(flow.kind, 'audio'); assert(flow.distinct);
    assert.equal(flow.channels, 1, 'Output is mono');
    assert(flow.peaks.raw > 0.01, `Fake microphone carries voice: ${JSON.stringify(flow.peaks)}`);
    assert(flow.peaks.filtered > 0.01, `Filtered voice is not silent: ${JSON.stringify(flow.peaks)}`);
    assert.deepEqual(flow.failures, []);
    console.log(`PASS: ${label} starts the filter on the fake microphone, output live mono audio, RMS ${flow.peaks.filtered.toFixed(3)} filtered vs ${flow.peaks.raw.toFixed(3)} raw`);

    // Failures after start are reported once, release the filter and leave the microphone live.
    const failures = await page.evaluate(async (module) => {
      const { createNoiseFilter } = await import(module);
      const mic = (await navigator.mediaDevices.getUserMedia({ audio: true })).getAudioTracks()[0];
      const settle = (ms = 300) => new Promise((resolve) => setTimeout(resolve, ms));
      const start = async () => {
        const failures = [];
        const filter = await createNoiseFilter(mic, (message) => failures.push(message));
        return { filter, failures, context: window.__contexts.at(-1), node: window.__nodes.at(-1) };
      };
      const report = ({ filter, failures, context }) => ({ failures, output: filter.track.readyState, context: context.state, mic: mic.readyState });
      const results = {};
      let run = await start(); run.filter.stop(); run.filter.stop(); await settle(); results.stopped = report(run);
      run = await start(); await run.context.close(); await settle(); run.filter.stop(); results.contextClosed = report(run);
      run = await start(); run.node.dispatchEvent(new Event('processorerror')); run.node.dispatchEvent(new Event('processorerror')); await settle(); results.processorError = report(run);
      run = await start(); run.node.port.dispatchEvent(new MessageEvent('message', { data: { type: 'error', message: 'test failure' } })); await settle(); results.workletError = report(run);
      run = await start(); mic.dispatchEvent(new Event('ended')); mic.dispatchEvent(new Event('ended')); await settle(); results.sourceEnded = report(run);
      run = await start(); await run.context.suspend(); await settle(500); results.suspendedRecovers = report(run); run.filter.stop();
      run = await start(); run.context.resume = () => new Promise(() => {}); await run.context.suspend(); await settle(3500); results.suspendedFails = report(run);
      const rejection = async (promise) => { try { await promise; return 'resolved'; } catch (error) { return error instanceof Error ? error.message : 'not an Error'; } };
      window.__corruptWasm = true;
      results.corrupt = await rejection(createNoiseFilter(mic, () => { results.corruptCallback = true; }));
      window.__corruptWasm = false;
      results.corruptContext = window.__contexts.at(-1).state;
      const controller = new AbortController();
      const cancelled = createNoiseFilter(mic, () => {}, controller.signal);
      controller.abort();
      results.aborted = await rejection(cancelled);
      results.preAborted = await rejection(createNoiseFilter(mic, () => {}, AbortSignal.abort()));
      window.__holdSuspended = true;
      results.neverRuns = await rejection(createNoiseFilter(mic, () => {}));
      window.__holdSuspended = false;
      await settle();
      results.contexts = window.__contexts.map((context) => context.state);
      results.mic = mic.readyState;
      mic.stop();
      return results;
    }, module);
    assert.deepEqual(failures.stopped, { failures: [], output: 'ended', context: 'closed', mic: 'live' }, 'stop() releases the filter and not the microphone');
    for (const key of ['contextClosed', 'processorError', 'workletError', 'sourceEnded', 'suspendedFails']) {
      const result = failures[key];
      assert.equal(result.failures.length, 1, `${key} reports exactly once: ${JSON.stringify(result)}`);
      assert(result.failures[0].includes('stopped'), `${key} message: ${result.failures[0]}`);
      assert.equal(result.output, "ended", `${key} ends the output: ${JSON.stringify(result)}`);
      assert.equal(result.context, 'closed', `${key} closes its context`);
      assert.equal(result.mic, 'live', `${key} leaves the microphone live`);
    }
    assert.deepEqual(failures.suspendedRecovers, { failures: [], output: 'live', context: 'running', mic: 'live' }, 'A briefly suspended context resumes');
    assert.match(failures.corrupt, /noise filter stopped working/, 'A worklet that cannot load RNNoise rejects startup');
    assert.equal(failures.corruptCallback, undefined, 'Startup failures reject without calling onFailure');
    assert.equal(failures.corruptContext, 'closed');
    assert.match(failures.aborted, /cancelled/); assert.match(failures.preAborted, /cancelled/);
    assert.match(failures.neverRuns, /too long/, 'A context that will not run fails startup');
    assert(failures.contexts.every((state) => state === 'closed'), `Every filter context is closed: ${failures.contexts}`);
    assert.equal(failures.mic, 'live');
    console.log(`PASS: ${label} reports failures once (closed context, processor error, worklet error, ended source, stuck suspension), recovers a brief suspension, rejects corrupt, cancelled and never-running startups, and never stops the microphone`);

    // A filter started bypassed keeps the startup handshake and failure reporting, and can be switched on in place.
    const bypass = await page.evaluate(async (module) => {
      const { createNoiseFilter } = await import(module);
      const mic = (await navigator.mediaDevices.getUserMedia({ audio: true })).getAudioTracks()[0];
      const settle = (ms = 300) => new Promise((resolve) => setTimeout(resolve, ms));
      const stats = (node) => new Promise((resolve) => {
        const listener = ({ data }) => { if (data.type === 'stats') { node.port.removeEventListener('message', listener); resolve(data); } };
        node.port.addEventListener('message', listener); node.port.postMessage({ type: 'stats' });
      });
      const results = {};
      let failures = [];
      let filter = await createNoiseFilter(mic, (message) => failures.push(message), undefined, { bypassed: true });
      let node = window.__nodes.at(-1);
      const track = filter.track;
      await settle(500); results.startBypassed = await stats(node);
      filter.setBypassed(false); await settle(500); results.switchedOn = await stats(node);
      filter.setBypassed(true); await settle(100); const before = await stats(node); await settle(500); const after = await stats(node);
      results.switchedOff = { ...after, ranWhileBypassed: after.denoised - before.denoised };
      results.sameTrack = filter.track === track; results.state = track.readyState;
      node.dispatchEvent(new Event('processorerror')); node.dispatchEvent(new Event('processorerror')); await settle();
      results.failures = failures; results.ended = track.readyState;
      filter.setBypassed(false); // A stopped filter ignores the control.
      results.rejected = 'resolved';
      try { await createNoiseFilter(mic, () => {}, AbortSignal.abort(), { bypassed: true }); } catch (error) { results.rejected = error.message; }
      results.mic = mic.readyState; mic.stop();
      return results;
    }, module);
    assert.equal(bypass.startBypassed.bypassed, true);
    assert.equal(bypass.startBypassed.denoised, 0, `A filter started bypassed never runs RNNoise: ${JSON.stringify(bypass)}`);
    assert.equal(bypass.switchedOn.bypassed, false);
    assert(bypass.switchedOn.denoised >= 30, `Switching on runs RNNoise on the same filter: ${JSON.stringify(bypass)}`);
    assert.equal(bypass.switchedOff.bypassed, true);
    assert.equal(bypass.switchedOff.ranWhileBypassed, 0, `Bypassing stops RNNoise: ${JSON.stringify(bypass)}`);
    assert(bypass.sameTrack); assert.equal(bypass.state, 'live');
    assert.equal(bypass.failures.length, 1, `A bypassed filter reports failure exactly once: ${JSON.stringify(bypass.failures)}`);
    assert.equal(bypass.ended, 'ended');
    assert.match(bypass.rejected, /cancelled/); assert.equal(bypass.mic, 'live');
    console.log(`PASS: ${label} starts a filter bypassed without running RNNoise, switches it on and off in place on one live track, and still reports failure once`);

    if (label === 'production build') {
      {
      // Bypassing mid-stream passes the noise through untouched, on time and without a gap, and resuming filters it again.
      const switched = await page.evaluate(async ({ module, samples }) => {
        const { createNoiseFilter } = await import(module);
        const bytes = Uint8Array.from(atob(samples), (c) => c.charCodeAt(0));
        const input = new Float32Array(bytes.buffer);
        const context = new AudioContext({ sampleRate: 48000 });
        const buffer = context.createBuffer(1, input.length, 48000); buffer.copyToChannel(input, 0);
        const player = context.createBufferSource(); player.buffer = buffer;
        const line = context.createMediaStreamDestination(); line.channelCount = 1; player.connect(line);
        const source = line.stream.getAudioTracks()[0];
        const filter = await createNoiseFilter(source, () => {});
        const track = filter.track;
        const merge = context.createChannelMerger(2);
        context.createMediaStreamSource(new MediaStream([source])).connect(merge, 0, 0);
        context.createMediaStreamSource(new MediaStream([filter.track])).connect(merge, 0, 1);
        const recorder = context.createScriptProcessor(4096, 2, 1);
        const raw = []; const filtered = [];
        recorder.onaudioprocess = ({ inputBuffer }) => { raw.push(inputBuffer.getChannelData(0).slice()); filtered.push(inputBuffer.getChannelData(1).slice()); };
        const mute = context.createGain(); mute.gain.value = 0;
        merge.connect(recorder).connect(mute).connect(context.destination);
        await new Promise((resolve) => setTimeout(resolve, 200));
        raw.length = 0; filtered.length = 0;
        player.start();
        const started = performance.now();
        const at = (seconds, action) => new Promise((resolve) => setTimeout(() => { action(); resolve(); }, seconds * 1000 - (performance.now() - started)));
        // Bypassed over most of the typing and the kitchen clatter, filtering everywhere else.
        await at(3.5, () => filter.setBypassed(true));
        await at(6.5, () => filter.setBypassed(false));
        await at(10.5, () => filter.setBypassed(true));
        await at(13.5, () => filter.setBypassed(false));
        await new Promise((resolve) => { player.onended = resolve; });
        await new Promise((resolve) => setTimeout(resolve, 500));
        const result = { sameTrack: filter.track === track, state: track.readyState };
        filter.stop(); await context.close();
        const join = (chunks) => { const all = new Float32Array(chunks.reduce((n, chunk) => n + chunk.length, 0)); let at = 0; for (const chunk of chunks) { all.set(chunk, at); at += chunk.length; } return all; };
        const encode = (array) => { const view = new Uint8Array(array.buffer); let text = ''; for (let i = 0; i < view.length; i += 0x8000) text += String.fromCharCode(...view.subarray(i, i + 0x8000)); return btoa(text); };
        return { ...result, raw: encode(join(raw)), filtered: encode(join(filtered)) };
      }, { module, samples: toBase64(signal) });
      assert(switched.sameTrack); assert.equal(switched.state, 'live');
      const raw = fromBase64(switched.raw); const filtered = fromBase64(switched.filtered);
      const rawStart = lag(frames(signal), frames(raw), 100);
      const coarse = lag(frames(raw.subarray(rawStart, rawStart + 3 * RATE)), frames(filtered.subarray(rawStart, rawStart + 3 * RATE)), 10);
      const window = (from, to) => [rawStart + Math.round(from * RATE), rawStart + Math.round(to * RATE)];
      const filterDelay = exactLag(raw, filtered, ...window(1, 2.5), coarse);
      const bypassDelays = [[4.2, 6], [11.2, 13]].map((range) => exactLag(raw, filtered, ...window(...range), coarse));
      const residual = ([from, to], delay) => { let error = 0; let total = 0; for (let i = from; i < to; i++) { error += (filtered[i + delay] - raw[i]) ** 2; total += raw[i] ** 2; } return decibels(error / total); };
      // Audio crossing between the filter's context and this one can slip a few samples now and then,
      // so the bypassed stretches are judged in quarter seconds.
      const blocks = [[4.25, 6], [11.25, 13]].flatMap(([from, to], n) => Array.from({ length: (to - from) * 4 }, (_, k) => residual(window(from + k / 4, from + (k + 1) / 4), bypassDelays[n])));
      const passthrough = blocks.filter((value) => value < -30).length / blocks.length;
      const change = (from, to) => { const [a, b] = window(from, to); return decibels(energy(filtered, a + filterDelay, b + filterDelay) / energy(raw, a, b)); };
      const resumed = { keyboard: change(3.1, 3.4), kitchen: change(10.1, 10.4), mixed: change(14.2, 15.8) };
      // No step at a switch: the output never jumps further between samples than the input does nearby.
      let worst = 0;
      for (const [i0, end] of [3.5, 6.5, 10.5, 13.5].map((at) => window(at - 0.25, at + 0.35))) for (let i = i0; i < end; i += 480) {
        let out = 0; let input = 0;
        for (let j = i; j < i + 480; j++) out = Math.max(out, Math.abs(filtered[j + filterDelay] - filtered[j + filterDelay - 1]));
        for (let j = i - 2400; j < i + 2880; j++) input = Math.max(input, Math.abs(raw[j] - raw[j - 1]));
        worst = Math.max(worst, out / Math.max(input, 1e-3));
      }
      console.log(`MEASURED: filtered delay ${filterDelay} samples, bypassed delay ${bypassDelays.join(' and ')}; ${(passthrough * 100).toFixed(0)}% of bypassed quarter seconds match the microphone to within 30 dB (median ${blocks.sort((a, b) => a - b)[blocks.length >> 1].toFixed(1)} dB); filtering before and after the bypasses changes typing by ${resumed.keyboard.toFixed(1)} dB, kitchen ${resumed.kitchen.toFixed(1)} dB, voice with typing ${resumed.mixed.toFixed(1)} dB; largest sample step ${worst.toFixed(2)}× the input's`);
      assert(passthrough >= 0.75, `Bypassed audio is the microphone audio (${(passthrough * 100).toFixed(0)}% of blocks)`);
      assert(resumed.kitchen <= -10, `Filtering resumes after a bypass (${resumed.kitchen.toFixed(1)} dB)`);
      assert(worst < 1.3, `No click when switching (${worst.toFixed(2)})`);
      console.log(`PASS: ${label} bypasses RNNoise mid-stream with the microphone audio passed through without a click, and resumes filtering on the same track`);
      }

      {
      // Switching neither skips nor repeats audio: the built worklet, with the options the module gives it,
      // switched at the same moments but rendered offline. Live, a MediaStream track between two contexts
      // now and then runs dry and inserts 10 ms of silence, at any moment and not only at a switch,
      // so the recording above cannot judge the delay to the sample.
      const rendered = await page.evaluate(async ({ module, samples }) => {
        const { createNoiseFilter } = await import(module);
        const mic = (await navigator.mediaDevices.getUserMedia({ audio: true })).getAudioTracks()[0];
        const filter = await createNoiseFilter(mic, () => {});
        const url = window.__worklets.at(-1); const options = window.__nodes.at(-1).__options;
        filter.stop(); mic.stop();
        const bytes = Uint8Array.from(atob(samples), (c) => c.charCodeAt(0));
        const input = new Float32Array(bytes.buffer);
        const quantum = 128 / 48000; const lead = 2;
        const context = new OfflineAudioContext(1, input.length + (lead + 0.5) * 48000, 48000);
        await context.audioWorklet.addModule(url);
        const node = new AudioWorkletNode(context, 'rnnoise', options);
        const buffer = context.createBuffer(1, input.length, 48000); buffer.copyToChannel(input, 0);
        const player = context.createBufferSource(); player.buffer = buffer;
        player.connect(node).connect(context.destination);
        let flowing = false; let answer = () => {};
        node.port.onmessage = ({ data }) => { if (data.type === 'flowing') flowing = true; if (data.type === 'stats') answer(data); };
        // Each switch is answered before rendering goes on, so it lands exactly where it was asked for.
        const bypass = async (bypassed) => { const stats = new Promise((resolve) => { answer = resolve; }); node.port.postMessage({ type: 'bypass', bypassed }); node.port.postMessage({ type: 'stats' }); return (await stats).bypassed === bypassed; };
        const result = { start: -1, switched: [] };
        // RNNoise loads while the first quanta render; the fixture starts once the worklet is running.
        const wait = (time) => context.suspend(time).then(async () => {
          await new Promise((resolve) => setTimeout(resolve, 10));
          if (!flowing && time + quantum < lead) wait(time + quantum);
          else if (flowing) {
            result.start = Math.round((time + quantum) * 48000); player.start(time + quantum);
            for (const [at, bypassed] of [[3.5, true], [6.5, false], [10.5, true], [13.5, false]]) {
              context.suspend(time + quantum + at).then(async () => { result.switched.push(await bypass(bypassed)); await context.resume(); });
            }
          }
          await context.resume();
        });
        wait(quantum);
        const output = (await context.startRendering()).getChannelData(0);
        const view = new Uint8Array(output.buffer); let text = '';
        for (let i = 0; i < view.length; i += 0x8000) text += String.fromCharCode(...view.subarray(i, i + 0x8000));
        return { ...result, output: btoa(text) };
      }, { module, samples: toBase64(signal) });
      assert(rendered.start >= 0, 'The worklet starts within two seconds of offline rendering');
      assert.deepEqual(rendered.switched, [true, true, true, true], 'Every offline switch reached the worklet');
      const output = fromBase64(rendered.output).subarray(rendered.start);
      const coarse = lag(frames(signal), frames(output), 10);
      const at = (from, to) => exactLag(signal, output, Math.round(from * RATE), Math.round(to * RATE), coarse);
      // Filtered voice before, between and after the bypasses; the bypassed stretches are raw noise.
      const filterDelays = [[1, 2.5], [7.2, 10], [14.2, 15.8]].map((range) => at(...range));
      const bypassDelays = [[4.2, 6], [11.2, 13]].map((range) => at(...range));
      console.log(`MEASURED: rendered offline, filtered delay ${filterDelays.join(', ')} samples before, between and after the bypasses; bypassed delay ${bypassDelays.join(' and ')}`);
      for (const delay of [...filterDelays, ...bypassDelays]) assert(Math.abs(delay - filterDelays[0]) <= 2, `Bypassed and filtered audio keep one delay, so switching neither skips nor repeats audio (${[...filterDelays, ...bypassDelays]})`);
      // A slip that recovers, as one in the warmup after resuming would, shows only near its switch. Bypassed
      // and warmup frames are the input to the bit, so every sample is checked: wherever a run of output copies
      // the input, it must copy it at that delay and never a frame or two either side.
      const delay = filterDelays[0];
      const copied = (shift) => {
        const runs = new Uint8Array(signal.length); let start = 0;
        for (let i = 0; i <= signal.length; i++) {
          if (i < signal.length && signal[i] !== 0 && output[i + shift] === signal[i]) continue;
          if (i - start >= 32) runs.fill(1, start, i);
          start = i + 1;
        }
        return runs;
      };
      const onTime = copied(delay);
      const slipped = [-960, -480, 480, 960].flatMap((d) => { const runs = copied(delay + d); const at = runs.indexOf(1); return at < 0 ? [] : [`${d > 0 ? '+' : ''}${d} at ${(at / RATE).toFixed(3)} s`]; });
      // Passthrough runs from just after each switch into bypass to the end of the warmup after it.
      const coverage = [[3.52, 6.6], [10.52, 13.6]].map(([from, to]) => {
        let total = 0; let hit = 0;
        for (let i = Math.round(from * RATE); i < Math.round(to * RATE); i++) if (signal[i] !== 0) { total++; hit += onTime[i]; }
        return hit / total;
      });
      console.log(`MEASURED: rendered offline, ${coverage.map((value) => `${(value * 100).toFixed(1)}%`).join(' and ')} of each bypass and its warmup copies the input at that delay; copies at other delays: ${slipped.join(', ') || 'none'}`);
      assert.deepEqual(slipped, [], `Bypassed and warmup audio never copies the input a frame early or late, so switching neither skips nor repeats audio even briefly`);
      for (const value of coverage) assert(value >= 0.99, `Bypassed and warmup audio copies the input at the filtered delay throughout (${(value * 100).toFixed(1)}%)`);
      console.log(`PASS: ${label} worklet keeps one delay through every switch, so bypassing neither skips nor repeats audio`);
      }

      // Noise-only stretches are attenuated while voiced stretches keep their energy.
      const recorded = await page.evaluate(async ({ module, samples }) => {
        const { createNoiseFilter } = await import(module);
        const bytes = Uint8Array.from(atob(samples), (c) => c.charCodeAt(0));
        const input = new Float32Array(bytes.buffer);
        const context = new AudioContext({ sampleRate: 48000 });
        const buffer = context.createBuffer(1, input.length, 48000); buffer.copyToChannel(input, 0);
        const player = context.createBufferSource(); player.buffer = buffer;
        const line = context.createMediaStreamDestination(); line.channelCount = 1; player.connect(line);
        const source = line.stream.getAudioTracks()[0];
        const filter = await createNoiseFilter(source, () => {});
        const merge = context.createChannelMerger(2);
        context.createMediaStreamSource(new MediaStream([source])).connect(merge, 0, 0);
        context.createMediaStreamSource(new MediaStream([filter.track])).connect(merge, 0, 1);
        const recorder = context.createScriptProcessor(4096, 2, 1);
        const raw = []; const filtered = [];
        recorder.onaudioprocess = ({ inputBuffer }) => { raw.push(inputBuffer.getChannelData(0).slice()); filtered.push(inputBuffer.getChannelData(1).slice()); };
        const mute = context.createGain(); mute.gain.value = 0;
        merge.connect(recorder).connect(mute).connect(context.destination);
        await new Promise((resolve) => setTimeout(resolve, 200));
        raw.length = 0; filtered.length = 0;
        player.start();
        await new Promise((resolve) => { player.onended = resolve; });
        await new Promise((resolve) => setTimeout(resolve, 500));
        filter.stop(); await context.close();
        const join = (chunks) => { const all = new Float32Array(chunks.reduce((n, chunk) => n + chunk.length, 0)); let at = 0; for (const chunk of chunks) { all.set(chunk, at); at += chunk.length; } return all; };
        const encode = (array) => { const view = new Uint8Array(array.buffer); let text = ''; for (let i = 0; i < view.length; i += 0x8000) text += String.fromCharCode(...view.subarray(i, i + 0x8000)); return btoa(text); };
        return { raw: encode(join(raw)), filtered: encode(join(filtered)) };
      }, { module, samples: toBase64(signal) });
      const raw = fromBase64(recorded.raw); const filtered = fromBase64(recorded.filtered);
      const rawStart = lag(frames(signal), frames(raw), 100);
      const filterDelay = lag(frames(raw.subarray(rawStart, rawStart + 4 * RATE)), frames(filtered.subarray(rawStart, rawStart + 4 * RATE)), 10);
      const margin = 0.1 * RATE;
      const measured = SEGMENTS.slice(1).map(({ kind, from, to }) => {
        const a = Math.round(from * RATE) + margin; const b = Math.round(to * RATE) - margin;
        const before = energy(raw, rawStart + a, rawStart + b); const after = energy(filtered, rawStart + a + filterDelay, rawStart + b + filterDelay);
        const voice = energy(clean, a, b) * before / energy(signal, a, b); // Clean voice, at the level it was recorded.
        return { kind, change: decibels(after / before), overVoice: voice && decibels(before / voice), afterOverVoice: voice && decibels(after / voice) };
      });
      const noise = measured.filter(({ kind }) => kind === 'keyboard' || kind === 'kitchen');
      const voice = measured.filter(({ kind }) => kind === 'voice');
      const mixed = measured.find(({ kind }) => kind === 'voice and keyboard');
      const voiceKept = 10 ** (Math.min(...voice.map(({ change }) => change)) / 10);
      console.log(`MEASURED: filter delay ${(filterDelay / RATE * 1000).toFixed(0)} ms (recording path included); ${noise.map(({ kind, change }) => `${kind} alone ${change.toFixed(1)} dB`).join(', ')}; voice alone ${voice.map(({ change }) => change.toFixed(1)).join(', ')} dB (keeps at least ${(voiceKept * 100).toFixed(0)}% of its energy); voice with keyboard at -10 dB: ${mixed.overVoice.toFixed(1)} dB above clean voice before, ${mixed.afterOverVoice.toFixed(1)} dB after`);
      for (const { kind, change } of noise) assert(change <= -10, `${kind} alone is reduced by at least 10 dB (measured ${change.toFixed(1)} dB)`);
      assert(voiceKept >= 0.8, `Voice alone keeps at least 80% of its energy (measured ${(voiceKept * 100).toFixed(0)}%)`);
      console.log(`PASS: ${label} reduces recorded typing and kitchen clatter by ${noise.map(({ change }) => (-change).toFixed(1)).join(' and ')} dB while recorded speech keeps ${(voiceKept * 100).toFixed(0)}% of its energy`);

      // Steady CPU: the renderer process with the filter running, against a plain pass-through graph.
      const cdp = await browser.newBrowserCDPSession();
      const cpu = async () => (await cdp.send('SystemInfo.getProcessInfo')).processInfo.reduce((sum, process) => sum + process.cpuTime, 0);
      const sample = async (seconds) => { const before = await cpu(); const started = Date.now(); await page.waitForTimeout(seconds * 1000); return ((await cpu()) - before) / ((Date.now() - started) / 1000) * 100; };
      await page.evaluate(async () => {
        window.__mic = (await navigator.mediaDevices.getUserMedia({ audio: true })).getAudioTracks()[0];
        window.__plain = new AudioContext({ sampleRate: 48000 });
        const out = window.__plain.createMediaStreamDestination();
        window.__plain.createMediaStreamSource(new MediaStream([window.__mic])).connect(out);
      });
      await page.waitForTimeout(1000);
      const plain = await sample(10);
      await page.evaluate(async (module) => {
        await window.__plain.close();
        const { createNoiseFilter } = await import(module);
        window.__filter = await createNoiseFilter(window.__mic, () => {});
      }, module);
      await page.waitForTimeout(1000);
      const filteredCpu = await sample(10);
      await page.evaluate(() => window.__filter.setBypassed(true));
      await page.waitForTimeout(1000);
      const bypassedCpu = await sample(10);
      await page.evaluate(() => { window.__filter.stop(); window.__mic.stop(); });
      console.log(`MEASURED: browser CPU (all processes) ${plain.toFixed(1)}% of one core with a pass-through graph, ${filteredCpu.toFixed(1)}% with the filter, ${bypassedCpu.toFixed(1)}% with it bypassed; filter cost ≈ ${(filteredCpu - plain).toFixed(1)}% of one core, ${(bypassedCpu - plain).toFixed(1)}% bypassed`);
    }

    assert.deepEqual(foreign, [], 'Nothing is fetched from another host');
    assert.deepEqual(errors, []);
    await context.close();
  }

  // Browsers without AudioWorklet or WebAssembly report the filter unavailable.
  for (const [missing, remove] of [
    ['AudioWorklet', () => { delete window.AudioWorkletNode; delete BaseAudioContext.prototype.audioWorklet; }],
    ['WebAssembly', () => { delete window.WebAssembly; }],
  ]) {
    for (const { label, origin, module } of origins) {
      const context = await browser.newContext({ permissions: ['microphone'] });
      await context.addInitScript(remove);
      const page = await context.newPage();
      const errors = [];
      page.on('pageerror', (error) => errors.push(error.message));
      await page.goto(`${origin}/audio/NOTICE.txt`);
      const result = await page.evaluate(async (module) => {
        const { createNoiseFilter, noiseFilterSupported } = await import(module);
        const mic = (await navigator.mediaDevices.getUserMedia({ audio: true })).getAudioTracks()[0];
        let rejected = 'resolved';
        try { await createNoiseFilter(mic, () => {}); } catch (error) { rejected = error.message; }
        const state = mic.readyState; mic.stop();
        return { supported: noiseFilterSupported(), rejected, state };
      }, module);
      assert.equal(result.supported, false, `${missing} missing on ${label}`);
      assert.match(result.rejected, /not supported/);
      assert.equal(result.state, 'live');
      assert.deepEqual(errors, []);
      await context.close();
    }
  }
  console.log('PASS: without AudioWorklet or WebAssembly the filter reports unsupported and startup rejects');
} finally {
  await browser.close();
  await server.close();
}
