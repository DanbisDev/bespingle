import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import { mkdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const world = JSON.parse(await readFile(new URL('../server/world.json', import.meta.url), 'utf8'));
const grid = world.grid;
assert.equal(grid.size, 48, 'The shared movement grid uses 48-pixel tiles');
const output = fileURLToPath(new URL('../test-results/browser/', import.meta.url));
await mkdir(output, { recursive: true });
const browser = await chromium.launch({
  executablePath: process.env.CHROME_PATH || undefined,
  headless: true,
  args: ['--no-sandbox', '--disable-background-timer-throttling', '--disable-renderer-backgrounding'],
});
const errors = [];
const contexts = [];
const canvasSelector = '[data-testid="game-canvas"]';
const vectors = { w: [0, -1], a: [-1, 0], s: [0, 1], d: [1, 0] };
const pointKey = ({ x, y }) => x + ',' + y;
const samePoint = (a, b) => a.x === b.x && a.y === b.y;

async function client(name) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  contexts.push(context);
  await context.addInitScript(() => {
    window.__messages = [];
    window.__sent = [];
    const Native = window.WebSocket;
    window.WebSocket = class extends Native {
      constructor(...args) {
        super(...args);
        window.__gameSocket = this;
        this.addEventListener('message', (event) => {
          const message = JSON.parse(event.data);
          window.__messages.push(message);
          if (message.selfId) window.__selfId = message.selfId;
          if (message.players) window.__players = message.players;
        });
      }
      send(data) {
        window.__sent.push(JSON.parse(data));
        return super.send(data);
      }
    };
  });
  const page = await context.newPage();
  page.on('pageerror', (error) => errors.push(name + ': ' + error.message));
  await page.goto(process.env.BESPINGLE_URL || 'http://127.0.0.1:5555');
  await page.getByLabel('Your display name').fill(name);
  await page.getByRole('button', { name: 'Enter the office', exact: true }).click();
  await page.getByRole('button', { name: 'Edit profile', exact: true }).waitFor();
  await page.waitForFunction(() => window.__players?.some((player) => player.id === window.__selfId));
  await page.waitForFunction(() => {
    const self = window.__players.find((player) => player.id === window.__selfId);
    const canvas = document.querySelector('[data-testid="game-canvas"]');
    return self && Number(canvas.dataset.x) === self.x && Number(canvas.dataset.y) === self.y;
  });
  return page;
}

async function state(page) {
  return page.locator(canvasSelector).evaluate((canvas) => ({
    x: Number(canvas.dataset.x), y: Number(canvas.dataset.y),
    renderX: Number(canvas.dataset.renderX), renderY: Number(canvas.dataset.renderY),
    moving: canvas.dataset.moving === 'true', bouncing: canvas.dataset.bouncing === 'true',
    bounceCount: Number(canvas.dataset.bounceCount), carpet: canvas.dataset.carpet,
    col: Number(canvas.dataset.tileCol), row: Number(canvas.dataset.tileRow),
  }));
}
async function waitAt(page, point) {
  await page.waitForFunction(({ x, y }) => {
    const canvas = document.querySelector('[data-testid="game-canvas"]');
    return Number(canvas.dataset.x) === x && Number(canvas.dataset.y) === y && canvas.dataset.moving !== 'true';
  }, point, { timeout: 3000 });
}
async function dismissPrompt(page) {
  if (await page.getByRole('dialog').count()) {
    await page.getByRole('button', { name: 'Neither', exact: false }).click();
    await page.getByRole('dialog').waitFor({ state: 'hidden' });
  }
}
async function focus(page) {
  await page.bringToFront();
  await page.locator(canvasSelector).focus();
}
async function step(page, key, inspect) {
  const before = await state(page);
  const [dx, dy] = vectors[key];
  const target = { x: before.x + dx * grid.size, y: before.y + dy * grid.size };
  await focus(page);
  await page.keyboard.down(key);
  try {
    await page.waitForFunction(() => document.querySelector('[data-testid="game-canvas"]').dataset.moving === 'true', null, { timeout: 1500 });
  } finally {
    await page.keyboard.up(key);
  }
  if (inspect) await inspect(before, target);
  await waitAt(page, target);
  return target;
}
// Match the shared eight-pixel feet radius and test complete movement segments.
function blocked(from, to) {
  if (to.x < 8 || to.x > world.width - 8 || to.y < 8 || to.y > world.height - 8) return true;
  return world.walls.some((wall) => {
    let enter = -Infinity;
    let leave = Infinity;
    for (const [origin, delta, lower, upper] of [
      [from.x, to.x - from.x, wall.x - 8, wall.x + wall.w + 8],
      [from.y, to.y - from.y, wall.y - 8, wall.y + wall.h + 8],
    ]) {
      if (delta === 0) {
        if (origin <= lower || origin >= upper) return false;
        continue;
      }
      const a = (lower - origin) / delta;
      const b = (upper - origin) / delta;
      enter = Math.max(enter, Math.min(a, b));
      leave = Math.min(leave, Math.max(a, b));
    }
    return enter < leave && leave > 0 && enter < 1;
  });
}
async function go(page, target) {
  const from = await state(page);
  if (samePoint(from, target)) return;
  const occupied = await page.evaluate(() => window.__players.filter((player) => player.id !== window.__selfId).flatMap((player) => [
    { x: player.x, y: player.y }, ...(player.move ? [{ x: player.move.toX, y: player.move.toY }] : []),
  ]));
  const unavailable = new Set(occupied.map(pointKey));
  const queue = [{ x: from.x, y: from.y, path: [] }];
  const visited = new Set([pointKey(from)]);
  let path;
  for (let i = 0; i < queue.length; i++) {
    const node = queue[i];
    if (samePoint(node, target)) { path = node.path; break; }
    for (const [key, [dx, dy]] of Object.entries(vectors)) {
      const next = { x: node.x + dx * grid.size, y: node.y + dy * grid.size };
      const id = pointKey(next);
      if (visited.has(id) || unavailable.has(id) || blocked(node, next)) continue;
      visited.add(id);
      queue.push({ ...next, path: [...node.path, key] });
    }
  }
  assert(path, 'A walkable, unoccupied route exists to ' + pointKey(target));
  for (const key of path) {
    await step(page, key);
    await dismissPrompt(page);
  }
}

try {
  const alice = await client('Chat Alice');
  await go(alice, { x: 504, y: 312 });
  const bob = await client('Chat Bob');
  await go(bob, { x: 600, y: 312 });
  const outsider = await client('Chat Outsider');
  const log = (page) => page.getByRole('log', { name: 'Carpet messages' });
  const say = async (page, text) => {
    await page.getByLabel('Message this carpet', { exact: true }).fill(text);
    await page.getByRole('button', { name: 'Send', exact: true }).click();
    await log(page).getByText(text, { exact: true }).waitFor();
  };
  const before = await state(alice);
  await alice.getByLabel('Message this carpet', { exact: true }).pressSequentially('wasd');
  assert(samePoint(before, await state(alice)), 'Typing does not move the avatar');
  await say(alice, '<hello carpet>');
  await log(bob).getByText('<hello carpet>', { exact: true }).waitFor();
  assert.equal(await outsider.getByRole('log').count(), 0);
  assert.equal(await outsider.evaluate(() => window.__messages.filter((m) => m.type === 'chat').length), 0);
  await go(outsider, { x: 648, y: 312 });
  assert.equal(await log(outsider).getByText('<hello carpet>', { exact: true }).count(), 0, 'No replay on arrival');
  await say(bob, 'Welcome!');
  await log(outsider).getByText('Welcome!', { exact: true }).waitFor();
  await go(alice, { x: 504, y: 408 });
  assert.equal(await alice.getByRole('log').count(), 0);
  await go(alice, { x: 504, y: 312 });
  assert.equal(await log(alice).locator('.chat-message').count(), 0, 'Leaving clears messages');
  await say(alice, 'Fresh message');
  await alice.setViewportSize({ width: 390, height: 844 });
  await alice.screenshot({ path: `${output}/chat-mobile.png`, fullPage: true });
  const box = await alice.getByLabel('Message this carpet', { exact: true }).boundingBox();
  assert(box && box.x >= 0 && box.x + box.width <= 390 && box.y + box.height <= 844, 'Mobile composer is visible');
  await alice.setViewportSize({ width: 1440, height: 900 });
  await alice.screenshot({ path: `${output}/chat-desktop.png`, fullPage: true });
  await alice.getByRole('button', { name: 'Leave office', exact: true }).click();
  await alice.getByRole('button', { name: 'Enter the office', exact: true }).click();
  await alice.getByRole('button', { name: 'Edit profile', exact: true }).waitFor();
  await alice.waitForFunction(() => document.querySelector('[data-testid="game-canvas"]').dataset.x);
  await go(alice, { x: 504, y: 312 });
  assert.equal(await log(alice).locator('.chat-message').count(), 0, 'Reconnecting has no history');
  assert.deepEqual(errors, []);
  console.log('Carpet chat browser checks passed: live delivery, isolation, no replay, clearing, typing, mobile layout.');
} finally {
  await Promise.all(contexts.map((context) => context.close()));
  await browser.close();
}
