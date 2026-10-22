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
          super(context, name, options); window.__nodes.push(this);
        }
      };
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

    if (label === 'production build') {
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
      await page.evaluate(() => { window.__filter.stop(); window.__mic.stop(); });
      console.log(`MEASURED: browser CPU (all processes) ${plain.toFixed(1)}% of one core with a pass-through graph, ${filteredCpu.toFixed(1)}% with the filter; filter cost ≈ ${(filteredCpu - plain).toFixed(1)}% of one core`);
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
