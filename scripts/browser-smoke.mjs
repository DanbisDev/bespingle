import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import { mkdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const world = JSON.parse(await readFile(new URL('../server/world.json', import.meta.url), 'utf8'));
const { size: tileSize, originX, originY } = world.grid;
const snap = (value, origin) => origin + Math.round((value - origin) / tileSize) * tileSize;

const output = fileURLToPath(new URL('../test-results/browser/', import.meta.url));
await mkdir(output, { recursive: true });
const browser = await chromium.launch({
  executablePath: process.env.CHROME_PATH || undefined,
  headless: true,
  args: ['--no-sandbox', '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream=fps=30', '--autoplay-policy=no-user-gesture-required', '--disable-background-timer-throttling', '--disable-renderer-backgrounding'],
});
const errors = [];
const contexts = [];
async function client(name, avatar) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, permissions: ['camera', 'microphone'] });
  contexts.push(context);
  await context.addInitScript(() => {
    window.__pcs = [];
    window.__streams = [];
    window.__captureRequests = [];
    window.__holdNextCapture = false;
    window.__releaseCapture = null;
    window.__wire = [];
    const Native = window.RTCPeerConnection;
    window.RTCPeerConnection = class extends Native { constructor(...args) { super(...args); window.__pcs.push(this); } };
    const capture = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
    navigator.mediaDevices.getUserMedia = async (...args) => {
      window.__captureRequests.push(args[0]);
      const stream = await capture(...args);
      if (args[0].audio) {
        // Send a controllable signal through the real peer connection so speech
        // highlighting can be checked independently of Chromium's fake mic tone.
        for (const track of stream.getAudioTracks()) { stream.removeTrack(track); track.stop(); }
        const audio = new AudioContext();
        const oscillator = audio.createOscillator();
        const gain = audio.createGain();
        const destination = audio.createMediaStreamDestination();
        gain.gain.value = 0;
        oscillator.connect(gain).connect(destination);
        oscillator.start();
        await audio.resume();
        const track = destination.stream.getAudioTracks()[0];
        stream.addTrack(track);
        window.__setVoice = (level) => { gain.gain.value = level; };
        const timer = setInterval(() => {
          if (track.readyState === 'ended') { clearInterval(timer); oscillator.stop(); void audio.close(); }
        }, 100);
      }
      window.__streams.push(stream);
      if (window.__holdNextCapture) {
        window.__holdNextCapture = false;
        await new Promise((resolve) => { window.__releaseCapture = resolve; });
      }
      return stream;
    };
    window.__screens = [];
    navigator.mediaDevices.getDisplayMedia = async () => {
      if (window.__cancelScreen) { window.__cancelScreen = false; throw new DOMException('Cancelled', 'NotAllowedError'); }
      if (window.__failScreen) { window.__failScreen = false; throw new DOMException('Screen capture failed.', 'NotReadableError'); }
      const canvas = document.createElement('canvas');
      canvas.width = 1280; canvas.height = 720;
      const ctx = canvas.getContext('2d');
      const paint = () => { ctx.fillStyle = '#113c52'; ctx.fillRect(0, 0, 1280, 720); ctx.fillStyle = 'white'; ctx.font = '48px sans-serif'; ctx.fillText(`Shared screen ${Date.now()}`, 40, 100); };
      paint();
      const stream = canvas.captureStream(15);
      const timer = setInterval(() => { if (stream.getTracks().every((track) => track.readyState === 'ended')) clearInterval(timer); else paint(); }, 66);
      window.__screens.push(stream);
      if (window.__holdScreen) { window.__holdScreen = false; await new Promise((resolve) => { window.__releaseScreen = resolve; }); }
      return stream;
    };
    const send = WebSocket.prototype.send;
    WebSocket.prototype.send = function(data) {
      if (this.url.endsWith('/ws')) {
        if (window.__socket !== this) this.addEventListener('message', (event) => { const message = JSON.parse(event.data); if (message.type === 'welcome') window.__selfId = message.selfId; });
        window.__socket = this;
        window.__wire.push(JSON.parse(data));
      }
      return send.call(this, data);
    };
  });
  const page = await context.newPage();
  page.on('pageerror', (error) => errors.push(`${name}: ${error.message}`));
  page.on('console', (message) => { if (message.type() === 'warning' || message.type() === 'error') console.log(name, message.type(), message.text()); });
  await page.goto(process.env.BESPINGLE_URL || 'http://127.0.0.1:5555');
  if (name === 'Alice') await page.screenshot({ path: `${output}/01-join.png`, fullPage: true });
  await page.getByLabel('Your display name').fill(name);
  await page.getByRole('button', { name: `${avatar} avatar`, exact: true }).click();
  await page.getByRole('button', { name: 'Enter the office', exact: true }).click();
  await page.getByRole('button', { name: 'Edit profile', exact: true }).waitFor();
  assert.equal(await page.evaluate(() => window.__streams.length), 0, 'No device capture before carpet prompt');
  return page;
}

async function position(page) {
  return page.locator('[data-testid="game-canvas"]').evaluate((canvas) => ({ x: Number(canvas.dataset.x || 640), y: Number(canvas.dataset.y || 700) }));
}
async function axis(page, target, coordinate) {
  target = snap(target, coordinate === 'x' ? originX : originY);
  const canvas = page.locator('[data-testid="game-canvas"]');
  // data-x and data-y are the tile a step leaves until it lands. A key held
  // into a dialog may already have queued a step past it, so read the start
  // only once that walk has finished.
  await page.waitForFunction(() => document.querySelector('[data-testid="game-canvas"]').dataset.moving !== 'true', null, { timeout: 2500 });
  for (let steps = 0; steps < 30; steps++) {
    const start = await position(page);
    if (start[coordinate] === target) return;
    const positive = target > start[coordinate];
    const key = coordinate === 'x' ? positive ? 'd' : 'a' : positive ? 's' : 'w';
    const destination = start[coordinate] + (positive ? tileSize : -tileSize);
    // A short tap reserves exactly one tile, then waits for its smooth landing.
    // Keeping the key held while polling a settled coordinate could queue an
    // extra tile before Playwright releases it.
    await page.keyboard.down(key);
    await canvas.waitFor({ state: 'visible' });
    await page.waitForTimeout(35);
    await page.keyboard.up(key);
    await page.waitForFunction(({ coordinate, destination }) => {
      const canvas = document.querySelector('[data-testid="game-canvas"]');
      return Number(canvas.dataset[coordinate]) === destination && canvas.dataset.moving !== 'true';
    }, { coordinate, destination }, { timeout: 2500 });
  }
  throw new Error(`Navigation did not reach ${coordinate}=${target}`);
}
async function go(page, x, y) {
  await page.bringToFront();
  await page.locator('[data-testid="game-canvas"]').focus();
  await axis(page, x, 'x');
  await axis(page, y, 'y');
}
async function choose(page, choice) {
  await page.getByRole('dialog').waitFor();
  await page.getByRole('button', { name: choice, exact: false }).click();
  await page.getByRole('dialog').waitFor({ state: 'hidden' });
}
async function captureState(page) {
  return page.evaluate(() => ({
    requests: window.__captureRequests,
    tracks: [...new Map(window.__streams.flatMap((stream) => stream.getTracks()).map((track) => [track.id, track])).values()]
      .map((track) => ({ id: track.id, kind: track.kind, state: track.readyState })),
  }));
}
async function expectDevices(page, mic, camera) {
  const microphone = page.getByRole('button', { name: `Turn microphone ${mic ? 'off' : 'on'}`, exact: true });
  const webcam = page.getByRole('button', { name: `Turn camera ${camera ? 'off' : 'on'}`, exact: true });
  await microphone.waitFor();
  await webcam.waitFor();
  await page.waitForFunction(({ mic, camera }) => {
    const microphone = document.querySelector(`[aria-label="Turn microphone ${mic ? 'off' : 'on'}"]`);
    const webcam = document.querySelector(`[aria-label="Turn camera ${camera ? 'off' : 'on'}"]`);
    return microphone && webcam && !microphone.disabled && !webcam.disabled;
  }, { mic, camera });
  assert(await microphone.isEnabled() && await webcam.isEnabled(), 'Device controls remain usable anywhere in the game');
}
async function stats(page) {
  return page.evaluate(async () => {
    const pc = window.__pcs.findLast((item) => item.connectionState === 'connected');
    if (!pc) return { connections: window.__pcs.map((item) => item.connectionState) };
    const report = await pc.getStats();
    const rows = [...report.values()];
    const pair = rows.find((row) => row.type === 'candidate-pair' && row.state === 'succeeded' && row.nominated);
    return {
      connections: window.__pcs.map((item) => item.connectionState),
      inbound: rows.filter((row) => row.type === 'inbound-rtp').map((row) => ({ kind: row.kind, bytes: row.bytesReceived, frames: row.framesDecoded })),
      outbound: rows.filter((row) => row.type === 'outbound-rtp').map((row) => ({ kind: row.kind, bytes: row.bytesSent, frames: row.framesEncoded })),
      candidateTypes: pair ? [report.get(pair.localCandidateId)?.candidateType, report.get(pair.remoteCandidateId)?.candidateType] : [],
      capture: window.__streams.flatMap((stream) => stream.getTracks().map((track) => ({ kind: track.kind, state: track.readyState, settings: (({width,height,frameRate})=>({width,height,frameRate}))(track.getSettings()) }))),
    };
  });
}

try {
  const alice = await client('Alice', 'Fern');
  const bob = await client('Bob', 'Blue');
  await alice.waitForFunction(() => Number(document.querySelector('[data-testid="game-canvas"]').dataset.playerCount) >= 2);
  await alice.screenshot({ path: `${output}/02-game-area.png`, fullPage: true });
  console.log('Joined two clients');

  const gameLayout = await alice.evaluate(() => {
    const area = document.querySelector('[data-testid="game-area"]').getBoundingClientRect();
    const viewport = document.querySelector('.game-viewport').getBoundingClientRect();
    const hud = document.querySelector('.game-hud').getBoundingClientRect();
    return { width: innerWidth, height: innerHeight, gameWidth: area.width, gameHeight: area.height,
      viewportWidth: viewport.width, viewportHeight: viewport.height, hudBottom: hud.bottom,
      pageHeight: document.documentElement.scrollHeight, scheme: getComputedStyle(document.documentElement).colorScheme };
  });
  assert(gameLayout.gameWidth >= gameLayout.width - 1, 'Game area spans the window width');
  assert(gameLayout.gameHeight >= gameLayout.height * 0.9, 'Game area uses nearly all the window height');
  assert(gameLayout.viewportHeight >= gameLayout.height * 0.75, 'Playable viewport dominates the window');
  assert(gameLayout.pageHeight <= gameLayout.height + 1 && gameLayout.hudBottom <= gameLayout.height + 1, 'HUD remains visible without page scrolling');
  assert.equal(gameLayout.scheme, 'dark', 'Night-mode browser controls');
  const gameCanvas = alice.locator('[data-testid="game-canvas"]');
  const initialPosition = await position(alice);
  const zoomBefore = Number(await gameCanvas.getAttribute('data-zoom'));
  await gameCanvas.hover();
  await alice.mouse.wheel(0, -120);
  await alice.waitForFunction((before) => Number(document.querySelector('[data-testid="game-canvas"]').dataset.zoom) > before, zoomBefore);
  const zoomIn = Number(await gameCanvas.getAttribute('data-zoom'));
  await alice.mouse.wheel(0, 240);
  await alice.waitForFunction((before) => Number(document.querySelector('[data-testid="game-canvas"]').dataset.zoom) < before, zoomBefore);
  const zoomOut = Number(await gameCanvas.getAttribute('data-zoom'));
  assert.deepEqual(await position(alice), initialPosition, 'Camera zoom does not move the player');
  await alice.mouse.wheel(0, -120);
  await alice.waitForFunction((before) => Math.abs(Number(document.querySelector('[data-testid="game-canvas"]').dataset.zoom) - before) < 0.001, zoomBefore);
  const cameraBefore = Number(await gameCanvas.getAttribute('data-camera-y'));
  await alice.setViewportSize({ width: 1024, height: 768 });
  await alice.waitForFunction(() => { const canvas = document.querySelector('[data-testid="game-canvas"]'); const rect = canvas.getBoundingClientRect(); const dpr = Math.min(devicePixelRatio || 1, 2); return Math.abs(rect.width - innerWidth) < 1 && canvas.width === Math.round(rect.width * dpr) && canvas.height === Math.round(rect.height * dpr); });
  assert(await alice.evaluate(() => document.querySelector('.game-hud').getBoundingClientRect().bottom <= innerHeight + 1 && document.documentElement.scrollHeight <= innerHeight + 1), 'Resizing keeps the game and HUD inside the window');
  await alice.setViewportSize({ width: 1440, height: 900 });
  await alice.waitForTimeout(100);
  await alice.screenshot({ path: `${output}/02-game-area.png`, fullPage: true });
  console.log('Full-window night layout, resize, and wheel zoom passed', { zoomBefore, zoomIn, zoomOut });

  // A signal addressed to oneself is rejected by the server: the error #11 is
  // about. A signal to an absent peer is dropped silently, so it cannot be used.
  const rejectSignal = () => alice.evaluate(() => window.__socket.send(JSON.stringify({ type: 'signal', to: window.__selfId, sessionId: 'smoke', candidate: { candidate: '' } })));
  const banner = alice.locator('.inline-error').filter({ hasText: 'signaling requires two participants on the same carpet' });
  await rejectSignal();
  await banner.waitFor();
  const shownAt = Date.now();
  await banner.waitFor({ state: 'hidden', timeout: 8000 });
  const expiredAfter = Date.now() - shownAt;
  assert(expiredAfter >= 4500, `Server errors stay up for five seconds (${expiredAfter}ms)`);
  await rejectSignal();
  await banner.waitFor();
  const dismiss = banner.getByRole('button', { name: 'Dismiss error', exact: true });
  await dismiss.focus();
  await alice.keyboard.press('Enter');
  await banner.waitFor({ state: 'hidden', timeout: 1000 });
  assert.equal(await alice.locator('.inline-error').count(), 0, 'A dismissed server error leaves no banner');
  console.log('Server errors expire after five seconds and close from the keyboard', { expiredAfter });

  // Straight walk to the middle carpet, stopping as soon as the prompt opens.
  await alice.bringToFront();
  await alice.locator('[data-testid="game-canvas"]').focus();
  await alice.keyboard.down('w');
  await alice.getByRole('dialog').waitFor();
  await alice.keyboard.up('w');
  await alice.screenshot({ path: `${output}/03-media-prompt.png`, fullPage: true });
  await choose(alice, 'Both');
  assert(Number(await gameCanvas.getAttribute('data-camera-y')) > cameraBefore, 'Camera follows the avatar toward the meeting carpets');
  assert.equal(await alice.evaluate(() => window.__streams.length), 1);

  // Distinct lanes keep both callers on the same carpet without sharing a tile.
  await go(bob, 552, 696);
  await bob.bringToFront();
  await bob.locator('[data-testid="game-canvas"]').focus();
  await bob.keyboard.down('w');
  await bob.getByRole('dialog').waitFor();
  await bob.keyboard.up('w');
  await choose(bob, 'Both');
  await alice.waitForFunction(() => window.__pcs.some((pc) => pc.connectionState === 'connected'), null, { timeout: 20000 });
  await bob.waitForFunction(() => window.__pcs.some((pc) => pc.connectionState === 'connected'), null, { timeout: 20000 });
  assert.equal(await alice.locator('.is-speaking').count(), 0, 'Silent microphones have no highlight');
  await alice.evaluate(() => window.__setVoice(0.15));
  await alice.locator('[data-testid="video-self"].is-speaking').waitFor();
  await bob.locator('[data-testid="video-peer"].is-speaking').waitFor();
  assert.equal(await alice.getByTestId('video-self').evaluate((tile) => getComputedStyle(tile).borderTopColor), 'rgb(142, 213, 255)', 'The speaking border is light blue');
  assert.equal(await bob.getByTestId('video-self').evaluate((tile) => tile.classList.contains('is-speaking')), false, 'A silent participant stays unhighlighted');
  await bob.evaluate(() => window.__setVoice(0.15));
  await alice.waitForFunction(() => document.querySelectorAll('.is-speaking').length === 2);
  await alice.getByTestId('video-peer').locator('.select-video').click();
  await alice.locator('.expanded .is-selected.is-speaking').waitFor();
  await alice.getByRole('button', { name: 'Back to game', exact: true }).click();
  await alice.screenshot({ path: `${output}/speaking-highlight.png`, fullPage: true });
  for (const page of [alice, bob]) await page.evaluate(() => window.__setVoice(0));
  for (const page of [alice, bob]) await page.waitForFunction(() => document.querySelectorAll('.is-speaking').length === 0);
  console.log('Speaking highlights passed: silence, local/remote voice, simultaneous speakers, light blue border, expanded view, and release');

  // Changing the noise level mid-call swaps Alice's audio sender in place: no new offer and no gap.
  const descriptions = (page) => page.evaluate(() => window.__wire.filter((message) => message.type === 'signal' && message.description).length);
  const before = { alice: await descriptions(alice), bob: await descriptions(bob) };
  const received = () => bob.evaluate(async () => {
    const pc = window.__pcs.findLast((item) => item.connectionState === 'connected');
    return [...(await pc.getStats()).values()].filter((row) => row.type === 'inbound-rtp' && row.kind === 'audio').reduce((sum, row) => sum + row.bytesReceived, 0);
  });
  const sent = () => alice.evaluate(() => {
    const pc = window.__pcs.findLast((item) => item.connectionState === 'connected');
    const track = pc.getTransceivers()[0].sender.track;
    const raw = window.__streams[0].getAudioTracks()[0];
    return { filtered: track.id !== raw.id, live: track.readyState === 'live', raw: raw.readyState };
  });
  await alice.evaluate(() => window.__setVoice(0.15));
  // Alice never chose a level, so her call started at the Strong default.
  await alice.waitForFunction(() => window.__pcs.findLast((item) => item.connectionState === 'connected')?.getTransceivers()[0].sender.track?.id !== window.__streams[0].getAudioTracks()[0].id);
  assert.deepEqual(await sent(), { filtered: true, live: true, raw: 'live' }, 'A call starts at Strong, sending the filter output');
  await alice.getByRole('button', { name: 'Microphone settings', exact: true }).click();
  assert(await alice.getByRole('radio', { name: 'Strong', exact: true }).isChecked(), 'Strong is the default level');
  for (const [name, filtered] of [['Off', false], ['Strong', true], ['Standard', false], ['Strong', true], ['Standard', false]]) {
    const bytes = await received();
    await alice.getByRole('radio', { name, exact: true }).click();
    await alice.waitForFunction((name) => { const input = document.querySelector(`.noise-level input[aria-label="${name}"]`); return input.checked && !input.closest('fieldset').disabled; }, name);
    assert.deepEqual(await sent(), { filtered, live: true, raw: 'live' }, `${name} sends ${filtered ? 'the filter output' : 'the raw microphone'} on the same sender`);
    await bob.waitForFunction(async (bytes) => {
      const pc = window.__pcs.findLast((item) => item.connectionState === 'connected');
      return [...(await pc.getStats()).values()].filter((row) => row.type === 'inbound-rtp' && row.kind === 'audio').reduce((sum, row) => sum + row.bytesReceived, 0) > bytes + 2000;
    }, bytes);
    await bob.locator('[data-testid="video-peer"].is-speaking').waitFor();
  }
  await alice.evaluate(() => window.__setVoice(0));
  await bob.waitForFunction(() => !document.querySelector('[data-testid="video-peer"]').classList.contains('is-speaking'));
  await alice.getByRole('button', { name: 'Done', exact: false }).click();
  assert.deepEqual({ alice: await descriptions(alice), bob: await descriptions(bob) }, before, 'Changing the noise level does not renegotiate');
  assert.equal((await captureState(alice)).requests.length, 1, 'Changing the noise level does not recapture');
  console.log('Noise level switching mid-call passed: filter output on the existing sender, no new offer, remote audio and speaking continue');
  await alice.waitForTimeout(1800);
  const aliceStats = await stats(alice);
  const bobStats = await stats(bob);
  console.log('Direct RTC statistics', JSON.stringify({ alice: aliceStats, bob: bobStats }, null, 2));
  for (const result of [aliceStats, bobStats]) {
    assert(result.inbound?.some((row) => row.kind === 'video' && row.bytes > 0 && row.frames > 0), 'Incoming video decodes');
    assert(result.inbound?.some((row) => row.kind === 'audio' && row.bytes > 0), 'Incoming audio arrives');
    assert(result.candidateTypes.length === 2 && !result.candidateTypes.includes('relay'), 'Media uses direct candidates');
    assert(result.capture.some((track) => track.kind === 'video' && track.settings.width === 1280 && track.settings.height === 720 && track.settings.frameRate === 30), 'Capture requests 720p30');
  }
  await alice.screenshot({ path: `${output}/04-direct-call.png`, fullPage: true });
  await alice.getByRole('button', { name: 'Expand', exact: true }).click();
  const equalTiles = await alice.locator('.expanded .video-tile').evaluateAll((tiles) => tiles.map((tile) => { const r = tile.getBoundingClientRect(); return { width: r.width, height: r.height }; }));
  assert.equal(await alice.locator('.is-selected').count(), 0, 'Expand opens an unpinned gallery');
  assert(equalTiles.every((tile) => tile.width > 500 && tile.height > 300 && Math.abs(tile.width - equalTiles[0].width) < 1 && Math.abs(tile.height - equalTiles[0].height) < 1), 'Unpinned cameras share the main view equally');
  await alice.screenshot({ path: `${output}/equal-videos.png`, fullPage: true });

  await alice.getByTestId('video-peer').locator('.select-video').click();
  await alice.locator('.call-strip.expanded').waitFor();
  assert(await alice.getByTestId('video-peer').evaluate((tile) => tile.classList.contains('is-selected')), 'Clicking a tile enlarges that video');
  await alice.evaluate(() => { window.__selectedVideo = document.querySelector('[data-testid="video-peer"] video'); });
  await alice.getByTestId('video-self').locator('.select-video').focus();
  await alice.keyboard.press('Enter');
  assert(await alice.getByTestId('video-self').evaluate((tile) => tile.classList.contains('is-selected')), 'Keyboard selection switches the main video');
  assert(await alice.evaluate(() => window.__selectedVideo === document.querySelector('[data-testid="video-peer"] video')), 'Switching preserves the mounted video element');
  const focusedBounds = await alice.locator('.video-tile').evaluateAll((tiles) => tiles.map((tile) => ({ selected: tile.classList.contains('is-selected'), width: tile.getBoundingClientRect().width, top: tile.getBoundingClientRect().top, bottom: tile.getBoundingClientRect().bottom })));
  assert(focusedBounds.find((tile) => tile.selected).width > 1000, 'Selected video fills the main area');
  assert(focusedBounds.filter((tile) => !tile.selected).every((tile) => tile.bottom <= focusedBounds.find((tile) => tile.selected).top && tile.width < 210), 'Other videos stay small in the top row');
  await alice.getByTestId('video-self').locator('.select-video').click();
  assert.equal(await alice.locator('.is-selected').count(), 0, 'Clicking a pinned tile unpins it');
  await alice.locator('.expanded .gallery').waitFor();
  assert(await alice.evaluate(() => window.__selectedVideo === document.querySelector('[data-testid="video-peer"] video')), 'Unpinning preserves video playback elements');
  await alice.getByTestId('video-self').locator('.select-video').click();
  await alice.getByRole('button', { name: 'Show all videos', exact: true }).click();
  assert.equal(await alice.locator('.is-selected').count(), 0, 'Show all videos clears the pin');
  await alice.getByTestId('video-self').locator('.select-video').click();

  await alice.setViewportSize({ width: 390, height: 844 });
  assert(await alice.getByTestId('video-self').evaluate((tile) => { const r = tile.getBoundingClientRect(); return r.left >= 0 && r.right <= innerWidth && r.height > 200; }), 'Selected video fits a mobile viewport');
  await alice.setViewportSize({ width: 1440, height: 900 });
  await alice.screenshot({ path: `${output}/05-expanded-videos.png`, fullPage: true });
  await alice.getByRole('button', { name: 'Back to game', exact: true }).click();

  // Side by side keeps the game playable beside the enlarged gallery.
  await alice.getByRole('button', { name: 'Side by side', exact: true }).click();
  await alice.locator('.call-strip.split .gallery').waitFor();
  const box = (selector) => alice.locator(selector).evaluate((node) => { const r = node.getBoundingClientRect(); return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: r.width, height: r.height }; });
  const [splitGallery, splitGame] = [await box('.split .video-grid'), await box('[data-testid="game-canvas"]')];
  assert(splitGallery.width > 300 && splitGallery.height > 300 && splitGame.width > 300 && splitGame.height > 300, 'Split shows the gallery and the game together');
  assert(splitGallery.right <= splitGame.left, 'The gallery sits left of the game without overlapping it');
  const splitStart = await position(alice);
  await go(alice, splitStart.x, splitStart.y - tileSize);
  assert.equal((await position(alice)).y, splitStart.y - tileSize, 'The avatar walks while the videos are enlarged');
  await go(alice, splitStart.x, splitStart.y);
  await alice.getByTestId('video-peer').locator('.select-video').click();
  assert(await alice.getByTestId('video-peer').evaluate((tile) => tile.classList.contains('is-selected')), 'Clicking a tile pins it inside split');
  await alice.getByTestId('video-peer').locator('.select-video').click();
  await alice.locator('.call-strip.split .gallery').waitFor();
  assert.equal(await alice.locator('.is-selected').count(), 0, 'Clicking the pinned tile unpins it without leaving split');
  const divider = alice.getByRole('separator', { name: 'Resize conversation videos', exact: true });
  const splitWidth = () => alice.locator('.call-strip.split').evaluate((node) => node.getBoundingClientRect().width);
  const widthBefore = await splitWidth();
  const resting = await position(alice);
  await divider.focus();
  await alice.keyboard.press('ArrowRight');
  assert.equal(await divider.getAttribute('aria-valuenow'), '55', 'ArrowRight widens the videos by five percent');
  assert(await splitWidth() > widthBefore + 50, 'The video column grows');
  assert.equal(await alice.evaluate(() => localStorage.getItem('bespingle_split_width')), '55', 'The divider width is remembered');
  await alice.keyboard.press('Escape');
  await alice.waitForTimeout(300);
  assert.deepEqual(await position(alice), resting, 'Keys on the divider do not move the avatar');
  assert.equal(await alice.locator('.call-strip.split').count(), 1, 'Escape does not leave split');
  await alice.screenshot({ path: `${output}/05b-split-view.png`, fullPage: true });
  await alice.getByRole('button', { name: 'Expand', exact: true }).click();
  await alice.locator('.call-strip.expanded').waitFor();
  await alice.getByRole('button', { name: 'Back to game', exact: true }).click();
  await alice.locator('.call-strip.split').waitFor();
  await alice.setViewportSize({ width: 390, height: 844 });
  const [stackedGallery, stackedGame] = [await box('.split .video-grid'), await box('[data-testid="game-canvas"]')];
  assert(stackedGallery.bottom <= stackedGame.top && stackedGame.height > 50 && await divider.isHidden(), 'Narrow split stacks the videos above the game');
  assert(await alice.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'Narrow split has no horizontal scroll');
  await alice.setViewportSize({ width: 1440, height: 900 });
  await alice.getByRole('button', { name: 'Back to strip', exact: true }).click();
  await alice.locator('.call-strip.split').waitFor({ state: 'detached' });
  console.log('Side by side passed: playable game, pin and unpin, keyboard resize, Escape ignored, full and back, narrow stacking');

  // Separate screen tracks must arrive alongside the camera and microphone.
  const beforeSharing = await captureState(alice);
  await alice.getByRole('button', { name: 'Share screen', exact: true }).click();
  await bob.getByTestId('screen-peer').waitFor();
  await bob.waitForFunction(() => { const video = document.querySelector('[data-testid="screen-peer"] video'); return video?.videoWidth === 1280 && video.currentTime > 0; });
  assert.deepEqual(await captureState(alice), beforeSharing, 'Sharing preserves camera and microphone tracks');
  await bob.getByRole('button', { name: 'Share screen', exact: true }).click();
  await alice.getByTestId('screen-peer').waitFor();
  await alice.waitForFunction(() => document.querySelector('[data-testid="screen-peer"] video')?.currentTime > 0);
  await alice.getByRole('button', { name: 'Expand', exact: true }).first().click();
  const tileBounds = await alice.locator('.expanded .video-tile').evaluateAll((tiles) => tiles.map((tile) => { const r = tile.getBoundingClientRect(); return { left: r.left, right: r.right, top: r.top, bottom: r.bottom }; }));
  for (let i = 0; i < tileBounds.length; i++) for (let j = i + 1; j < tileBounds.length; j++) {
    const a = tileBounds[i], b = tileBounds[j];
    assert(a.right <= b.left || b.right <= a.left || a.bottom <= b.top || b.bottom <= a.top, 'Expanded screen and camera tiles do not overlap');
  }
  await alice.getByTestId('screen-peer').locator('.select-video').click();
  assert(await alice.getByTestId('screen-peer').evaluate((tile) => tile.classList.contains('is-selected')), 'A shared screen can be selected independently');
  await alice.setViewportSize({ width: 390, height: 844 });
  const beforeThumbnailScroll = await alice.getByTestId('screen-peer').boundingBox();
  await alice.locator('.video-grid').evaluate((row) => { row.scrollLeft = row.scrollWidth; });
  const afterThumbnailScroll = await alice.getByTestId('screen-peer').boundingBox();
  assert.deepEqual(afterThumbnailScroll, beforeThumbnailScroll, 'Scrolling the top row leaves the selected video in place');
  await alice.getByTestId('video-peer').locator('.select-video').click();
  assert(await alice.getByTestId('video-peer').evaluate((tile) => tile.classList.contains('is-selected')), 'Overflowing thumbnails remain selectable on mobile');
  await alice.setViewportSize({ width: 1440, height: 900 });
  await alice.getByTestId('screen-peer').locator('.select-video').click();
  await alice.screenshot({ path: `${output}/screen-sharing.png`, fullPage: true });
  await alice.getByRole('button', { name: 'Back to game', exact: true }).click();
  await alice.getByRole('button', { name: 'Stop sharing screen', exact: true }).click();
  await bob.getByTestId('screen-peer').waitFor({ state: 'detached' });
  assert(await alice.evaluate(() => window.__screens.every((stream) => stream.getTracks().every((track) => track.readyState === 'ended'))));
  await alice.getByTestId('screen-peer').locator('.select-video').focus();
  await alice.keyboard.press('Space');
  assert(await alice.getByTestId('screen-peer').evaluate((tile) => tile.classList.contains('is-selected')), 'Space selects a shared screen');
  await bob.evaluate(() => { const track = window.__screens.at(-1).getVideoTracks()[0]; track.stop(); track.dispatchEvent(new Event('ended')); });
  await alice.getByTestId('screen-peer').waitFor({ state: 'detached' });
  await alice.locator('.expanded .gallery').waitFor();
  assert.equal(await alice.locator('.expanded .video-tile.is-selected').count(), 0, 'A disappearing pinned share returns to the equal gallery');
  await alice.keyboard.press('Escape');
  await alice.locator('.call-strip.expanded').waitFor({ state: 'detached' });
  await alice.evaluate(() => { window.__cancelScreen = true; });
  await alice.getByRole('button', { name: 'Share screen', exact: true }).click();
  await alice.waitForFunction(() => !document.querySelector('[aria-label="Share screen"]').disabled);
  assert.equal(await alice.getByTestId('screen-self').count(), 0, 'Cancelling capture does not start sharing');
  // A device error seen in a device dialog does not follow into the banner.
  await alice.evaluate(() => { window.__failScreen = true; });
  await alice.getByRole('button', { name: 'Share screen', exact: true }).click();
  const deviceBanner = alice.locator('.inline-error').filter({ hasText: 'Screen capture failed.' });
  await deviceBanner.waitFor();
  await alice.getByRole('button', { name: 'Video settings', exact: true }).click();
  const videoDialog = alice.getByRole('dialog', { name: 'Video settings' });
  await videoDialog.locator('.form-error').filter({ hasText: 'Screen capture failed.' }).waitFor();
  assert.equal(await deviceBanner.count(), 0, 'An open video settings dialog keeps its device error out of the banner');
  await alice.evaluate(() => { window.__bannerSeen = false; new MutationObserver(() => { if (document.querySelector('.inline-error')) window.__bannerSeen = true; }).observe(document.body, { childList: true, subtree: true }); });
  await videoDialog.getByRole('button', { name: 'Done', exact: false }).click();
  await videoDialog.waitFor({ state: 'detached' });
  await alice.waitForTimeout(200);
  assert.equal(await alice.locator('.inline-error').count(), 0, 'Closing video settings leaves no device error in the banner');
  assert.equal(await alice.evaluate(() => window.__bannerSeen), false, 'The device error never reaches the banner as video settings closes');
  await alice.getByRole('button', { name: 'Share screen', exact: true }).click();
  await bob.getByTestId('screen-peer').waitFor();
  console.log('Concurrent screen shares, received frames, preserved devices, explicit stop, browser stop, and cancellation passed');

  const initialCapture = await captureState(alice);
  const originalAudio = initialCapture.tracks.find((track) => track.kind === 'audio').id;
  const originalVideo = initialCapture.tracks.find((track) => track.kind === 'video').id;
  assert.equal(initialCapture.requests.length, 1, 'The initial choice captures both devices once');

  // Carpet membership controls transmission, while device choices persist in the game.
  await go(alice, 640, 450);
  await alice.waitForFunction(() => window.__pcs.every((pc) => pc.connectionState === 'closed'));
  await bob.waitForFunction(() => window.__pcs.every((pc) => pc.connectionState === 'closed'));
  assert(await alice.evaluate(() => window.__screens.every((stream) => stream.getTracks().every((track) => track.readyState === 'ended'))), 'Leaving a carpet stops screen capture');
  await expectDevices(alice, true, true);
  assert.deepEqual(await captureState(alice), initialCapture, 'Leaving a carpet preserves the same live capture without recapturing');
  assert.equal(await alice.getByRole('dialog').count(), 0, 'The open floor does not prompt again');
  await alice.screenshot({ path: `${output}/06-persistent-devices.png`, fullPage: true });

  await go(alice, 188, 450);
  await go(alice, 188, 300);
  assert.equal(await alice.getByRole('dialog').count(), 0, 'Entering a different carpet remembers the device choice');
  await expectDevices(alice, true, true);
  assert.equal(await alice.evaluate(() => window.__pcs.filter((pc) => pc.connectionState !== 'closed').length), 0, 'Separate carpets have no peer connection');
  assert.deepEqual(await captureState(alice), initialCapture, 'The next carpet reuses both original tracks');

  // Rejoin Bob and transmit the original capture without another permission prompt.
  await go(alice, 188, 450);
  await go(alice, 640, 450);
  await go(alice, 640, 350);
  await alice.waitForFunction(() => window.__pcs.some((pc) => pc.connectionState === 'connected'));
  await bob.waitForFunction(() => window.__pcs.some((pc) => pc.connectionState === 'connected'));
  await alice.waitForTimeout(1200);
  assert.equal(await alice.getByRole('dialog').count(), 0, 'Rejoining a conversation does not prompt again');
  assert.deepEqual(await captureState(alice), initialCapture, 'Rejoining uses the same capture and does not reopen devices');
  const resumed = await stats(bob);
  assert(resumed.inbound.some((row) => row.kind === 'video' && row.frames > 0), 'Rejoining resumes outgoing video');
  assert(resumed.inbound.some((row) => row.kind === 'audio' && row.bytes > 0), 'Rejoining resumes outgoing audio');
  console.log('Carpet isolation and persistent capture/re-entry passed');

  // Manual open-floor toggles stop only their selected device.
  await go(alice, 640, 450);
  await alice.waitForFunction(() => window.__pcs.every((pc) => pc.connectionState === 'closed'));
  await alice.getByRole('button', { name: 'Turn microphone off', exact: true }).click();
  await expectDevices(alice, false, true);
  const cameraOnly = await captureState(alice);
  assert.equal(cameraOnly.requests.length, 1, 'Disabling a microphone does not request new capture');
  assert.equal(cameraOnly.tracks.find((track) => track.id === originalAudio).state, 'ended', 'Disabling the microphone stops the audio track');
  assert.equal(cameraOnly.tracks.find((track) => track.id === originalVideo).state, 'live', 'Disabling the microphone preserves the same camera track');
  await alice.getByRole('button', { name: 'Turn camera off', exact: true }).click();
  await expectDevices(alice, false, false);
  assert((await captureState(alice)).tracks.every((track) => track.state === 'ended'), 'Disabling both devices stops all capture');

  // A manually muted choice also persists on entry while remote media is received.
  await go(alice, 640, 350);
  await alice.waitForFunction(() => window.__pcs.some((pc) => pc.connectionState === 'connected'));
  await alice.waitForTimeout(1200);
  await expectDevices(alice, false, false);
  assert.equal(await alice.getByRole('dialog').count(), 0, 'Manual device choices persist without another prompt');
  assert.equal((await captureState(alice)).requests.length, 1, 'Re-entry with devices off does not capture');
  const receiveOnly = await stats(alice);
  assert(receiveOnly.inbound.some((row) => row.kind === 'video' && row.frames > 0), 'Devices off still receives remote video');
  assert(receiveOnly.inbound.some((row) => row.kind === 'audio' && row.bytes > 0), 'Devices off still receives remote audio');
  assert(await alice.evaluate(() => window.__pcs.filter((pc) => pc.connectionState === 'connected').every((pc) => pc.getSenders().every((sender) => !sender.track))), 'Devices off sends no local tracks');

  // Enable each device separately: only the missing media kind may be opened.
  await alice.getByRole('button', { name: 'Turn microphone on', exact: true }).click();
  await expectDevices(alice, true, false);
  const microphoneOnly = await captureState(alice);
  assert.equal(microphoneOnly.requests.length, 2);
  assert(microphoneOnly.requests[1].audio && microphoneOnly.requests[1].video === false, 'Microphone-only requests no camera');
  const resumedAudio = microphoneOnly.tracks.find((track) => track.kind === 'audio' && track.state === 'live').id;
  assert.deepEqual(microphoneOnly.tracks.filter((track) => track.state === 'live').map((track) => track.kind), ['audio']);
  await alice.evaluate(() => window.__setVoice(0.15));
  await alice.locator('[data-testid="video-self"].is-speaking:not(.has-video)').waitFor();
  await bob.locator('[data-testid="video-peer"].is-speaking:not(.has-video)').waitFor();
  await alice.evaluate(() => window.__setVoice(0));
  await alice.waitForFunction(() => !document.querySelector('[data-testid="video-self"]').classList.contains('is-speaking'));
  await bob.waitForFunction(() => !document.querySelector('[data-testid="video-peer"]').classList.contains('is-speaking'));
  await alice.getByRole('button', { name: 'Turn camera on', exact: true }).click();
  await expectDevices(alice, true, true);
  const restoredCapture = await captureState(alice);
  assert.equal(restoredCapture.requests.length, 3);
  assert(restoredCapture.requests[2].video && restoredCapture.requests[2].audio === false, 'Adding camera requests no new microphone');
  assert.equal(restoredCapture.tracks.find((track) => track.id === resumedAudio).state, 'live', 'Adding camera preserves the already enabled microphone');
  assert.deepEqual(restoredCapture.tracks.filter((track) => track.state === 'live').map((track) => track.kind).sort(), ['audio', 'video']);
  console.log('Open-floor toggles, remembered mute state, receive-only, and incremental capture passed');

  await alice.evaluate(() => window.__setVoice(0.15));
  await bob.locator('[data-testid="video-peer"].is-speaking').waitFor();
  await alice.getByRole('button', { name: 'Turn microphone off', exact: true }).click();
  for (const [page, tile] of [[alice, 'video-self'], [bob, 'video-peer']]) {
    await page.waitForFunction((id) => !document.querySelector(`[data-testid="${id}"]`).classList.contains('is-speaking'), tile);
  }
  console.log('Camera-off speaking and immediate mute clearing passed');

  await alice.getByRole('button', { name: 'Edit profile', exact: true }).click();
  await alice.getByRole('textbox', { name: 'Display name', exact: true }).fill('Alice Updated');
  await alice.getByRole('button', { name: 'Save profile', exact: false }).click();
  await bob.getByText('Alice Updated', { exact: true }).waitFor();
  console.log('Display name update synchronized');

  const wire = await alice.evaluate(() => ({ types: [...new Set(window.__wire.map((message) => message.type))], rtcConfig: window.__pcs[0].getConfiguration(), maxBytes: Math.max(...window.__wire.map((message) => JSON.stringify(message).length)) }));
  assert(wire.types.every((type) => ['join', 'move', 'media', 'profile', 'signal'].includes(type)));
  assert(wire.rtcConfig.iceServers.every((server) => JSON.stringify(server.urls).includes('stun:') && !JSON.stringify(server.urls).includes('turn:')));
  // Leaving the game, rather than a carpet, ends every capture and clears the choice.
  await alice.getByRole('button', { name: 'Leave office', exact: true }).click();
  await alice.getByRole('button', { name: 'Enter the office', exact: true }).waitFor();
  await alice.waitForFunction(() => window.__pcs.every((pc) => pc.connectionState === 'closed') && window.__streams.every((stream) => stream.getTracks().every((track) => track.readyState === 'ended')));
  await bob.waitForFunction(() => window.__pcs.every((pc) => pc.connectionState === 'closed'));
  const requestsBeforeRejoin = (await captureState(alice)).requests.length;
  await alice.getByLabel('Your display name').fill('Alice Updated');
  await alice.getByRole('button', { name: 'Enter the office', exact: true }).click();
  await alice.getByRole('button', { name: 'Edit profile', exact: true }).waitFor();
  await expectDevices(alice, false, false);
  assert.equal((await captureState(alice)).requests.length, requestsBeforeRejoin, 'A new game starts with both devices off');
  await alice.locator('[data-testid="game-canvas"]').focus();
  await alice.keyboard.down('w');
  await alice.getByRole('dialog').waitFor();
  await alice.keyboard.up('w');
  await choose(alice, 'Neither');
  assert.equal((await captureState(alice)).requests.length, requestsBeforeRejoin, 'The next game asks again and Neither opens no devices');

  await alice.evaluate(() => { window.__holdScreen = true; });
  await alice.getByRole('button', { name: 'Share screen', exact: true }).click();
  await alice.waitForFunction(() => typeof window.__releaseScreen === 'function');
  await go(alice, 640, 450);
  await alice.evaluate(() => window.__releaseScreen());
  await alice.waitForFunction(() => window.__screens.every((stream) => stream.getTracks().every((track) => track.readyState === 'ended')));
  assert.equal(await alice.getByTestId('screen-self').count(), 0, 'A late screen selection cannot resume sharing on the floor');
  await go(alice, 640, 350);

  // A permission result that arrives after leaving must never revive capture.
  await alice.evaluate(() => { window.__holdNextCapture = true; });
  await alice.getByRole('button', { name: 'Turn camera on', exact: true }).click();
  await alice.waitForFunction(() => typeof window.__releaseCapture === 'function');
  await alice.getByRole('button', { name: 'Leave office', exact: true }).click();
  await alice.getByRole('button', { name: 'Enter the office', exact: true }).waitFor();
  await alice.evaluate(() => { window.__releaseCapture(); window.__releaseCapture = null; });
  await alice.waitForFunction(() => window.__pcs.every((pc) => pc.connectionState === 'closed') && window.__streams.every((stream) => stream.getTracks().every((track) => track.readyState === 'ended')));
  assert.equal((await captureState(alice)).requests.length, requestsBeforeRejoin + 1, 'Pending capture is not retried after leaving');
  console.log('Leaving the game stops capture, resets the prompt, and invalidates late permission results');

  assert.deepEqual(errors, [], 'No uncaught browser errors');
  console.log('PASS', JSON.stringify({ wire, screenshots: output, browserErrors: errors }));
} catch (error) {
  for (let i = 0; i < contexts.length; i++) {
    const page = contexts[i].pages()[0];
    await page.screenshot({ path: `${output}/failure-${i}.png`, fullPage: true }).catch(() => {});
    console.log(`Client ${i} diagnostics`, JSON.stringify({ position: await position(page).catch(() => null), stats: await stats(page).catch(() => null), text: await page.locator('body').innerText().catch(() => ''), wire: await page.evaluate(() => window.__wire.slice(-12).map(({type,description,from,to})=>({type,descriptionType:description?.type,from,to}))).catch(() => []) }));
  }
  console.log('Browser errors', errors);
  throw error;
} finally {
  await browser.close();
}
