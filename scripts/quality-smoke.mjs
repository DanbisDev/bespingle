import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const world = JSON.parse(await readFile(new URL('../server/world.json', import.meta.url), 'utf8'));
const { size: tileSize, originX, originY } = world.grid;
const snap = (value, origin) => origin + Math.round((value - origin) / tileSize) * tileSize;
const url = process.env.BESPINGLE_URL || 'http://127.0.0.1:5555';

const browser = await chromium.launch({
  executablePath: process.env.CHROME_PATH || undefined,
  headless: true,
  args: ['--no-sandbox', '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream=fps=30', '--autoplay-policy=no-user-gesture-required', '--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows'],
});
const errors = [];
const pages = [];

async function client(name) {
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, permissions: ['camera', 'microphone'] });
  await context.addInitScript(() => {
    window.__pcs = [];
    window.__negotiations = 0;
    const Native = window.RTCPeerConnection;
    window.RTCPeerConnection = class extends Native {
      constructor(...args) { super(...args); window.__pcs.push(this); }
      // Every quality change must reuse the existing session description.
      createOffer(...args) { window.__negotiations += 1; return super.createOffer(...args); }
      createAnswer(...args) { window.__negotiations += 1; return super.createAnswer(...args); }
    };
    // Count-driven steps are checked at no device load. Six clients on one test
    // machine do load it, so both load signals are pinned to normal here.
    // test:load drives them.
    delete window.PressureObserver;
    const getStats = RTCRtpSender.prototype.getStats;
    RTCRtpSender.prototype.getStats = async function (...args) {
      const report = await getStats.apply(this, args);
      return new Map([...report].map(([id, row]) => {
        if (row.type !== 'outbound-rtp' || row.kind !== 'video') return [id, row];
        const { qualityLimitationDurations: _, ...rest } = row;
        return [id, { ...rest, qualityLimitationReason: 'none' }];
      }));
    };
    navigator.mediaDevices.getDisplayMedia = async () => {
      const canvas = document.createElement('canvas');
      canvas.width = 1280; canvas.height = 720;
      const ctx = canvas.getContext('2d');
      const stream = canvas.captureStream(15);
      const timer = setInterval(() => {
        if (stream.getTracks().every((track) => track.readyState === 'ended')) clearInterval(timer);
        ctx.fillStyle = '#113c52'; ctx.fillRect(0, 0, 1280, 720); ctx.fillStyle = 'white'; ctx.font = '48px sans-serif'; ctx.fillText(`Shared ${Date.now()}`, 40, 100);
      }, 66);
      return stream;
    };
  });
  const page = await context.newPage();
  page.on('pageerror', (error) => errors.push(`${name}: ${error.message}`));
  page.on('console', (message) => { if (message.type() === 'warning' || message.type() === 'error') console.log(name, message.type(), message.text()); });
  await page.goto(url);
  await page.getByLabel('Your display name').fill(name);
  await page.getByRole('button', { name: 'Enter the office', exact: true }).click();
  await page.getByRole('button', { name: 'Edit profile', exact: true }).waitFor();
  pages.push(page);
  return page;
}

async function position(page) {
  return page.locator('[data-testid="game-canvas"]').evaluate((canvas) => ({ x: Number(canvas.dataset.x), y: Number(canvas.dataset.y) }));
}
async function axis(page, target, coordinate) {
  target = snap(target, coordinate === 'x' ? originX : originY);
  for (let steps = 0; steps < 30; steps++) {
    const start = await position(page);
    if (start[coordinate] === target) return;
    const positive = target > start[coordinate];
    const key = coordinate === 'x' ? positive ? 'd' : 'a' : positive ? 's' : 'w';
    const destination = start[coordinate] + (positive ? tileSize : -tileSize);
    await page.keyboard.down(key);
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
// Walks up a lane onto the Studio carpet and turns both devices on.
async function enter(page, lane) {
  await go(page, lane, 696);
  await page.bringToFront();
  await page.locator('[data-testid="game-canvas"]').focus();
  await page.keyboard.down('w');
  await page.getByRole('dialog').waitFor();
  await page.keyboard.up('w');
  if (await page.getByRole('button', { name: 'Both', exact: false }).count()) {
    await page.getByRole('button', { name: 'Both', exact: false }).click();
    await page.getByRole('dialog').waitFor({ state: 'hidden' });
  }
}
async function leave(page, lane) { await go(page, lane, 456); }

// Every open connection's camera sender, read from its encoding parameters.
function senders(page) {
  return page.evaluate(() => window.__pcs.filter((pc) => pc.connectionState !== 'closed').map((pc) => {
    const [, camera] = pc.getTransceivers();
    const encoding = camera?.sender.getParameters().encodings?.[0] ?? {};
    return { state: pc.connectionState, active: encoding.active, scale: encoding.scaleResolutionDownBy, fps: encoding.maxFramerate, bitrate: encoding.maxBitrate };
  }));
}
const step = { 720: { scale: 1, fps: 30 }, 540: { scale: 1280 / 960, fps: 24 }, 360: { scale: 2, fps: 15 } };
async function expectCamera(page, peers, rung, active = true) {
  const want = step[rung];
  try {
    await page.waitForFunction(({ peers, want, active }) => {
      const open = window.__pcs.filter((pc) => pc.connectionState !== 'closed');
      return open.length === peers && open.every((pc) => {
        if (pc.connectionState !== 'connected') return false;
        const encoding = pc.getTransceivers()[1]?.sender.getParameters().encodings?.[0];
        return encoding && encoding.active === active && (!active || Math.abs(encoding.scaleResolutionDownBy - want.scale) < 0.01 && encoding.maxFramerate === want.fps);
      });
    }, { peers, want, active }, { timeout: 25000 });
  } catch (error) {
    console.log('Unexpected camera senders', JSON.stringify(await senders(page)));
    throw error;
  }
}
async function everyone(list, peers, rung) { for (const page of list) await expectCamera(page, peers, rung); }
function outbound(page) {
  return page.evaluate(async () => {
    const rows = [];
    for (const pc of window.__pcs.filter((item) => item.connectionState === 'connected')) {
      for (const [index, transceiver] of pc.getTransceivers().entries()) {
        for (const row of (await transceiver.sender.getStats()).values()) {
          if (row.type === 'outbound-rtp') rows.push({ kind: ['audio', 'camera', 'screen'][index], bytes: row.bytesSent, frames: row.framesEncoded, height: row.frameHeight, fps: row.framesPerSecond });
        }
      }
    }
    return rows;
  });
}
const sum = (rows, kind, field) => rows.filter((row) => row.kind === kind).reduce((total, row) => total + (row[field] ?? 0), 0);
async function chooseQuality(page, label) {
  await page.bringToFront();
  await page.getByRole('button', { name: 'Microphone settings', exact: true }).click();
  await page.getByRole('radio', { name: label, exact: true }).check();
  await page.getByRole('button', { name: 'Done', exact: false }).click();
}
const negotiations = (list) => Promise.all(list.map((page) => page.evaluate(() => window.__negotiations)));
const audioTracks = (page) => page.evaluate(() => window.__pcs.filter((pc) => pc.connectionState === 'connected').map((pc) => pc.getTransceivers()[0].sender.track?.id));

try {
  const lanes = [648, 600, 552, 504, 456];
  // Clients join one at a time so nobody spawns in another's lane.
  const alice = await client('Alice');
  await alice.getByRole('button', { name: 'Microphone settings', exact: true }).click();
  assert(await alice.getByRole('radio', { name: 'Auto', exact: true }).isChecked(), 'Video quality defaults to Auto');
  await alice.getByRole('button', { name: 'Done', exact: false }).click();
  await enter(alice, lanes[0]);
  // Free Alice's lane for a sixth arrival.
  await go(alice, lanes[0], 312);
  const bob = await client('Bob');
  await enter(bob, lanes[1]);
  const carol = await client('Carol');
  await enter(carol, lanes[2]);
  await everyone([alice, bob, carol], 2, 720);
  console.log('Three on a carpet: every camera is sent at 720p30');

  const dave = await client('Dave');
  await enter(dave, lanes[3]);
  await everyone([alice, bob, carol, dave], 3, 540);
  await alice.waitForTimeout(2500);
  const four = await outbound(alice);
  assert(four.filter((row) => row.kind === 'camera').every((row) => row.height <= 540), `Four on a carpet send at most 540p: ${JSON.stringify(four)}`);
  console.log('Four on a carpet: every camera steps down to 540p24, for earlier and later peers on both sides', JSON.stringify(four));

  // Manual choices fix quality on the chooser only, whatever the count.
  const beforeManual = await negotiations([alice, bob, carol, dave]);
  const aliceAudio = await audioTracks(alice);
  const audioBefore = sum(await outbound(alice), 'audio', 'bytes');
  await chooseQuality(alice, 'High');
  await expectCamera(alice, 3, 720);
  await expectCamera(bob, 3, 540);
  await chooseQuality(alice, 'Low');
  await expectCamera(alice, 3, 360);
  await chooseQuality(alice, 'Auto');
  await expectCamera(alice, 3, 540);
  await alice.waitForTimeout(1000);
  assert(sum(await outbound(alice), 'audio', 'bytes') > audioBefore, 'Audio keeps flowing through manual changes');
  assert.deepEqual(await audioTracks(alice), aliceAudio, 'Quality changes keep the same audio track');
  assert.deepEqual(await negotiations([alice, bob, carol, dave]), beforeManual, 'Manual quality changes create no offer or answer');
  console.log('High and Low fix quality regardless of count without renegotiation');

  const erin = await client('Erin');
  await enter(erin, lanes[4]);
  await everyone([alice, bob, carol, dave, erin], 4, 540);
  const frank = await client('Frank');
  await enter(frank, lanes[0]);
  await everyone([alice, bob, carol, dave, erin, frank], 5, 360);
  await alice.waitForTimeout(2500);
  const six = await outbound(alice);
  assert(six.filter((row) => row.kind === 'camera').every((row) => row.height <= 360), `Six on a carpet send at most 360p: ${JSON.stringify(six)}`);
  console.log('Six on a carpet: every camera steps down to 360p15', JSON.stringify(six));

  await leave(frank, lanes[0]);
  await everyone([alice, bob, carol, dave, erin], 4, 540);
  await leave(erin, lanes[4]);
  await leave(dave, lanes[3]);
  await everyone([alice, bob, carol], 2, 720);
  console.log('Leaving steps every camera back up: 540p24 at five, 720p30 at three');

  // Audio only stops the camera reaching peers while audio and screen continue.
  await alice.bringToFront();
  await alice.getByRole('button', { name: 'Share screen', exact: true }).click();
  await bob.locator('[data-testid="screen-peer"] video').waitFor();
  await bob.waitForFunction(() => document.querySelector('[aria-label="Alice video"]')?.closest('.video-tile').classList.contains('has-video'));
  const beforeAudioOnly = await negotiations([alice, bob, carol]);
  const audioOnlyStart = await outbound(alice);
  await chooseQuality(alice, 'Audio only');
  await expectCamera(alice, 2, 720, false);
  await bob.waitForFunction(() => !document.querySelector('[aria-label="Alice video"]').closest('.video-tile').classList.contains('has-video'));
  assert.equal(await alice.getByRole('button', { name: 'Turn camera off', exact: true }).count(), 1, 'The camera stays on locally in Audio only');
  const pausedA = await outbound(alice);
  await alice.waitForTimeout(1500);
  const pausedB = await outbound(alice);
  const screenTime = await bob.evaluate(() => document.querySelector('[data-testid="screen-peer"] video').currentTime);
  assert(sum(pausedB, 'audio', 'bytes') > sum(audioOnlyStart, 'audio', 'bytes'), 'Audio continues in Audio only');
  assert(sum(pausedB, 'camera', 'frames') - sum(pausedA, 'camera', 'frames') <= 2, `Camera stops encoding in Audio only: ${JSON.stringify({ pausedA, pausedB })}`);
  assert(sum(pausedB, 'screen', 'frames') > sum(pausedA, 'screen', 'frames'), 'Screen share keeps encoding in Audio only');
  await bob.waitForFunction((time) => document.querySelector('[data-testid="screen-peer"] video').currentTime > time, screenTime);
  await chooseQuality(alice, 'Auto');
  await expectCamera(alice, 2, 720, true);
  await bob.waitForFunction(() => document.querySelector('[aria-label="Alice video"]')?.closest('.video-tile').classList.contains('has-video'));
  const resumed = sum(await outbound(alice), 'camera', 'frames');
  await alice.waitForTimeout(1000);
  assert(sum(await outbound(alice), 'camera', 'frames') > resumed, 'The camera resumes after Audio only');
  assert.deepEqual(await negotiations([alice, bob, carol]), beforeAudioOnly, 'Audio only and back create no offer or answer');
  console.log('Audio only hides the camera, keeps audio and screen, and returns without rejoining');

  await chooseQuality(carol, 'Low');
  await carol.reload();
  await carol.getByLabel('Your display name').fill('Carol');
  await carol.getByRole('button', { name: 'Enter the office', exact: true }).click();
  await carol.getByRole('button', { name: 'Microphone settings', exact: true }).click();
  assert(await carol.getByRole('radio', { name: 'Low', exact: true }).isChecked(), 'Video quality survives a reload');
  console.log('The video quality choice survives a reload');

  assert.deepEqual(errors, [], 'No uncaught browser errors');
  console.log('PASS: count-driven camera steps, manual High/Low/Audio only, no renegotiation, and persistence');
} catch (error) {
  for (const [index, page] of pages.entries()) {
    await page.screenshot({ path: `test-results/quality-failure-${index}.png` }).catch(() => {});
    console.log(`Client ${index}`, JSON.stringify({ position: await position(page).catch(() => null), senders: await senders(page).catch(() => null) }));
  }
  throw error;
} finally {
  await browser.close();
}
