import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { cp, mkdir, readFile, rm, utimes, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Drops, deploys and refreshes need a server this script can stop and start,
// so it runs its own Go server on a built frontend rather than the dev stack.
const root = fileURLToPath(new URL('../', import.meta.url));
const output = join(root, 'test-results/reconnect');
const buildA = join(output, 'build-a');
const buildB = join(output, 'build-b');
const binary = join(root, '.cache/reconnect-server');
const port = process.env.RECONNECT_PORT || '6687';
const url = `http://127.0.0.1:${port}`;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

await mkdir(output, { recursive: true });
execFileSync(process.execPath, ['node_modules/vite/bin/vite.js', 'build', '--outDir', buildA, '--emptyOutDir', '--logLevel', 'warn'], { cwd: root, stdio: 'inherit' });
// The same files under another build identity stand in for a deploy of new code.
await rm(buildB, { recursive: true, force: true });
await cp(buildA, buildB, { recursive: true });
const html = await readFile(join(buildB, 'index.html'), 'utf8');
const buildIdA = html.match(/<meta name="bespingle-build" content="([0-9a-f]{16})"/)?.[1];
assert(buildIdA, 'The build stamps its identity into index.html');
const buildIdB = buildIdA === 'f'.repeat(16) ? '0'.repeat(16) : 'f'.repeat(16);
await writeFile(join(buildB, 'index.html'), html.replace(buildIdA, buildIdB));
// Last-Modified has one-second resolution; a deploy's page is never the same second's.
const later = new Date(Date.now() + 60000);
await utimes(join(buildB, 'index.html'), later, later);
execFileSync('go', ['build', '-o', binary, './server'], { cwd: root, stdio: 'inherit' });

let server = null;
async function startServer(staticDir) {
  server = spawn(binary, [], { env: { ...process.env, HOST: '127.0.0.1', PORT: port, STATIC_DIR: staticDir, ALLOWED_ORIGINS: url }, stdio: ['ignore', 'inherit', 'inherit'] });
  for (let i = 0; i < 100; i++) {
    try { if ((await fetch(url)).ok) return; } catch { /* Not listening yet. */ }
    await sleep(100);
  }
  throw new Error('The server did not start');
}
async function stopServer() {
  const current = server;
  server = null;
  if (!current || current.exitCode !== null) return;
  const exited = new Promise((resolve) => current.once('exit', resolve));
  current.kill('SIGTERM');
  await exited;
}

const browser = await chromium.launch({
  executablePath: process.env.CHROME_PATH || undefined,
  headless: true,
  args: ['--no-sandbox', '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--disable-background-timer-throttling', '--disable-renderer-backgrounding'],
});
const errors = [];
const pages = [];
async function context({ refuseStorage = false } = {}) {
  const context = await browser.newContext({ viewport: { width: 1280, height: 860 }, permissions: ['camera', 'microphone'] });
  await context.addInitScript((refuseStorage) => {
    if (refuseStorage) {
      for (const method of ['getItem', 'setItem', 'removeItem']) Storage.prototype[method] = () => { throw new DOMException('Storage is disabled', 'SecurityError'); };
    }
    window.__sockets = [];
    window.__joins = [];
    window.__self = null;
    window.__sawJoinForm = false;
    window.__sawPrompt = false;
    window.__captures = [];
    const capture = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
    navigator.mediaDevices.getUserMedia = (constraints) => {
      window.__captures.push({ audio: !!constraints.audio, video: !!constraints.video });
      return capture(constraints);
    };
    const Native = window.WebSocket;
    window.WebSocket = class extends Native {
      constructor(...args) {
        super(...args);
        window.__sockets.push(performance.now());
        window.__socket = this;
        this.addEventListener('message', (event) => {
          const message = JSON.parse(event.data);
          if (message.type === 'welcome') window.__selfId = message.selfId;
          if (message.type === 'welcome' || message.type === 'state') window.__self = message.players.find((player) => player.id === window.__selfId) ?? window.__self;
        });
      }
      send(data) {
        const message = JSON.parse(data);
        if (message.type === 'join') window.__joins.push(message);
        return super.send(data);
      }
    };
    new MutationObserver(() => {
      if (document.querySelector('.join-dialog')) window.__sawJoinForm = true;
      if (document.querySelector('.media-dialog')) window.__sawPrompt = true;
    }).observe(document, { childList: true, subtree: true });
  }, refuseStorage);
  return context;
}
async function open(context) {
  const page = await context.newPage();
  pages.push(page);
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(url);
  return page;
}
const place = (page) => page.evaluate(() => { const self = window.__self; return self && { x: self.x, y: self.y, facing: self.facing, carpetId: self.carpetId }; });
const sawJoinForm = (page) => page.evaluate(() => window.__sawJoinForm);
const sockets = (page) => page.evaluate(() => window.__sockets);
const inOffice = (page, timeout = 5000) => page.getByRole('button', { name: 'Edit profile', exact: true }).waitFor({ timeout });
const joinForm = (page) => page.getByRole('button', { name: 'Enter the office', exact: true }).waitFor();
const banner = (page) => page.getByText('Reconnecting…', { exact: true });
async function settled(page) {
  await page.waitForFunction(() => document.querySelector('[data-testid="game-canvas"]')?.dataset.moving === 'false');
}

try {
  await startServer(buildA);
  const office = await context();
  const page = await open(office);
  await page.getByLabel('Your display name').fill('Rosa');
  await page.getByRole('button', { name: 'Enter the office', exact: true }).click();
  await inOffice(page);
  assert.deepEqual(await page.evaluate(() => window.__joins.map(({ x, y, facing }) => ({ x, y, facing }))), [{ x: undefined, y: undefined, facing: undefined }], 'A first visit asks for no tile');
  assert.equal((await place(page)).facing, 'down');

  // Onto a carpet, facing up, which a fresh join never is.
  await page.locator('[data-testid="game-canvas"]').focus();
  await page.keyboard.down('w');
  await page.getByRole('dialog').waitFor();
  await page.keyboard.up('w');
  await page.getByRole('button', { name: 'Neither', exact: false }).click();
  await page.getByRole('dialog').waitFor({ state: 'hidden' });
  await settled(page);
  const seat = await place(page);
  assert(seat.carpetId, 'The person stands on a carpet');
  assert.equal(seat.facing, 'up');
  const expectSeat = async (page, why) => {
    await settled(page);
    assert.deepEqual(await place(page), seat, why);
  };

  // A deploy: the server goes away and comes back with the same build.
  await page.evaluate(() => { window.__sawJoinForm = false; });
  await stopServer();
  await banner(page).waitFor();
  assert.equal(await page.locator('.join-dialog').count(), 0, 'A drop does not show the join form');
  assert.equal(await page.getByRole('button', { name: 'Leave office', exact: true }).count(), 0, 'The banner replaces the controls');
  await page.screenshot({ path: `${output}/01-reconnecting.png` });
  await startServer(buildA);
  await inOffice(page, 15000);
  assert.equal(await banner(page).count(), 0, 'The banner goes away by itself');
  await expectSeat(page, 'A reconnect returns to the same tile, facing and carpet');
  assert.equal(await sawJoinForm(page), false, 'The form never showed while reconnecting');
  assert.deepEqual(await page.evaluate(() => { const { x, y, facing } = window.__joins.at(-1); return { x, y, facing }; }), { x: seat.x, y: seat.y, facing: seat.facing }, 'The rejoin asks for the last tile');
  console.log('A restarted server rejoins the same tile without the form', seat);

  await page.reload();
  await inOffice(page);
  await expectSeat(page, 'A refresh returns to the same tile');
  assert.equal(await sawJoinForm(page), false, 'A refresh never shows the join form');
  console.log('A refresh rejoins without the form');

  const second = await open(office);
  await joinForm(second);
  await second.waitForTimeout(500);
  assert.deepEqual(await sockets(second), [], 'A second tab does not rejoin the same person');
  await second.close();
  await expectSeat(page, 'The first tab stays in the office');
  console.log('A second tab shows the join form');

  // Backoff, then Leave from the banner stops it.
  await stopServer();
  await banner(page).waitFor();
  const before = (await sockets(page)).length;
  await page.waitForFunction((count) => window.__sockets.length >= count + 3, before, { timeout: 15000 });
  const attempts = (await sockets(page)).slice(before);
  const gaps = attempts.slice(1).map((time, index) => time - attempts[index]);
  assert(Math.abs(gaps[0] - 2000) < 400 && Math.abs(gaps[1] - 4000) < 400, `Retries double their wait (${gaps.map(Math.round)}ms)`);
  await page.getByRole('button', { name: 'Leave', exact: true }).click();
  await joinForm(page);
  const afterLeave = (await sockets(page)).length;
  await page.waitForTimeout(9000);
  assert.equal((await sockets(page)).length, afterLeave, 'Leave stops the retries');
  console.log('Retries back off and stop on Leave', { gaps: gaps.map(Math.round) });

  await startServer(buildA);
  await page.reload();
  await joinForm(page);
  await page.waitForTimeout(500);
  assert.deepEqual(await sockets(page), [], 'Leave then refresh shows the form without rejoining');
  await page.getByRole('button', { name: 'Enter the office', exact: true }).click();
  await inOffice(page);
  await expectSeat(page, 'Entering from the form returns to the last tile');
  console.log('After leaving, a refresh shows the form and entering returns to the last tile');

  // A new build: the page reloads itself onto it and rejoins.
  let loads = 0;
  page.on('load', () => { loads++; });
  assert.equal(await page.evaluate(() => document.querySelector('meta[name="bespingle-build"]').content), buildIdA);
  await page.evaluate(() => { window.__sawJoinForm = false; });
  await stopServer();
  await banner(page).waitFor();
  await startServer(buildB);
  for (let i = 0; i < 150 && !loads; i++) await sleep(100);
  assert.equal(loads, 1, 'A different build reloads the page once');
  await inOffice(page, 15000);
  assert.equal(await page.evaluate(() => document.querySelector('meta[name="bespingle-build"]').content), buildIdB);
  await expectSeat(page, 'The reloaded page rejoins the same tile');
  assert.equal(await sawJoinForm(page), false, 'The build reload never shows the join form');
  console.log('A new build reloads the page, which rejoins');

  // This session entered from the form and never answered, so a rejoin still asks.
  await page.getByRole('button', { name: 'Neither', exact: false }).click();
  await page.getByRole('button', { name: 'Leave office', exact: true }).click();
  await joinForm(page);
  await page.reload();
  await joinForm(page);
  assert.deepEqual(await sockets(page), [], 'The leave button marks the person out of the office');
  await office.close();

  // Devices: what was on comes back after a rejoin, where permission is still granted.
  const devicesOffice = await context();
  const devices = await open(devicesOffice);
  const captures = () => devices.evaluate(() => window.__captures);
  const expectDevices = (mic, camera) => devices.waitForFunction(([mic, camera]) => window.__self?.mic === mic && window.__self?.camera === camera, [mic, camera], { timeout: 10000 });
  const note = devices.getByRole('alert').filter({ hasText: 'left off because the browser needs your permission' });
  await devices.getByLabel('Your display name').fill('Ines');
  await devices.getByRole('button', { name: 'Enter the office', exact: true }).click();
  await inOffice(devices);
  await devices.locator('[data-testid="game-canvas"]').focus();
  await devices.keyboard.down('w');
  await devices.locator('.media-dialog').waitFor();
  await devices.keyboard.up('w');
  await devices.getByRole('button', { name: 'Both', exact: false }).click();
  await expectDevices(true, true);
  await devices.reload();
  await inOffice(devices);
  await expectDevices(true, true);
  assert.deepEqual(await captures(), [{ audio: true, video: true }], 'A refresh reopens both devices, once');
  assert.equal(await devices.evaluate(() => window.__sawPrompt), false, 'A refresh does not ask for devices again');
  await devices.evaluate(() => window.__socket.close());
  await banner(devices).waitFor();
  await inOffice(devices, 15000);
  await expectDevices(true, true);
  assert.deepEqual(await captures(), [{ audio: true, video: true }, { audio: true, video: true }], 'A reconnect reopens both devices');
  assert.equal(await devices.evaluate(() => window.__sawPrompt), false, 'A reconnect does not ask for devices again');
  console.log('A refresh and a reconnect bring the microphone and camera back without a click');

  await devices.getByRole('button', { name: 'Turn camera off', exact: true }).click();
  await expectDevices(true, false);
  await devices.reload();
  await inOffice(devices);
  await expectDevices(true, false);
  await devices.waitForTimeout(500);
  assert.deepEqual(await captures(), [{ audio: true, video: false }], 'Only the microphone comes back');
  assert.equal(await devices.getByRole('button', { name: 'Turn camera on', exact: true }).count(), 1);
  console.log('With only the microphone on, only the microphone comes back');

  await devices.getByRole('button', { name: 'Turn camera on', exact: true }).click();
  await expectDevices(true, true);
  await devicesOffice.clearPermissions();
  await devicesOffice.grantPermissions(['microphone'], { origin: url });
  await devices.reload();
  await inOffice(devices);
  await expectDevices(true, false);
  await note.waitFor();
  assert.match(await note.innerText(), /Your camera was left off/);
  assert.deepEqual(await captures(), [{ audio: true, video: false }], 'No camera request without the camera permission');
  await devicesOffice.clearPermissions();
  await devices.reload();
  await inOffice(devices);
  await note.waitFor();
  assert.match(await note.innerText(), /microphone and camera were left off/);
  await devices.waitForTimeout(500);
  assert.deepEqual(await captures(), [], 'No capture request without permission');
  assert.equal(await devices.evaluate(() => window.__self.mic || window.__self.camera), false, 'Both stay off');
  assert.equal(await devices.evaluate(() => window.__sawPrompt), false, 'Missing permission does not bring back the prompt');
  await devices.screenshot({ path: `${output}/02-left-off.png` });
  console.log('Without permission the devices stay off with a note, and nothing is requested');

  await devicesOffice.grantPermissions(['camera', 'microphone'], { origin: url });
  await devices.getByRole('button', { name: 'Leave office', exact: true }).click();
  await joinForm(devices);
  await devices.getByRole('button', { name: 'Enter the office', exact: true }).click();
  await inOffice(devices);
  await devices.locator('.media-dialog').waitFor();
  assert.equal(await devices.evaluate(() => window.__self.mic || window.__self.camera), false, 'Entering from the form starts with both off');
  assert.deepEqual(await captures(), [], 'Entering from the form opens nothing');
  await devices.getByRole('button', { name: 'Neither', exact: false }).click();
  await devices.locator('.media-dialog').waitFor({ state: 'hidden' });
  await devices.reload();
  await inOffice(devices);
  await devices.waitForTimeout(500);
  assert.equal(await devices.evaluate(() => window.__sawPrompt), false, 'Neither is remembered as an answer');
  assert.deepEqual(await captures(), []);
  console.log('Entering from the form starts with devices off and asks on the carpet');
  await devicesOffice.close();

  const privateMode = await context({ refuseStorage: true });
  const guarded = await open(privateMode);
  await guarded.getByLabel('Your display name').fill('Sol');
  await guarded.getByRole('button', { name: 'Enter the office', exact: true }).click();
  await inOffice(guarded);
  await guarded.reload();
  await joinForm(guarded);
  console.log('Refused storage behaves as before');
  await privateMode.close();

  assert.deepEqual(errors, [], 'No uncaught browser errors');
  console.log('PASS');
} catch (error) {
  for (const [index, page] of pages.entries()) {
    if (page.isClosed()) continue;
    await page.screenshot({ path: `${output}/failure-${index}.png` }).catch(() => {});
    console.log(`Page ${index}`, JSON.stringify({ text: await page.locator('body').innerText().catch(() => ''), joins: await page.evaluate(() => window.__joins).catch(() => null) }));
  }
  console.log('Browser errors', errors);
  throw error;
} finally {
  await browser.close();
  await stopServer();
}
