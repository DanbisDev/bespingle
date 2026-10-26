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
  const alice = await client('Scrimba Alice');
  await go(alice, { x: 504, y: 312 });
  const bob = await client('Scrimba Bob');
  await go(bob, { x: 600, y: 312 });
  const outsider = await client('Scrimba Outsider');
  const say = async (page, text) => {
    await page.getByLabel('Message this carpet', { exact: true }).fill(text);
    await page.getByRole('button', { name: 'Send', exact: true }).click();
  };
  const panel = (page) => page.getByRole('dialog', { name: 'Scrimba', exact: true });
  const board = (page) => panel(page).locator('.scrimba-board');
  const latest = (page) => page.evaluate(() => window.__messages.filter((m) => m.type === 'scrimba-state').at(-1));
  const guess = async (page, names) => {
    const before = await panel(page).locator('.scrimba-cell.correct, .scrimba-cell.present, .scrimba-cell.absent').count();
    for (const name of names) await panel(page).getByRole('button', { name: new RegExp('^Add ' + name) }).click();
    await panel(page).getByRole('button', { name: 'Guess', exact: true }).click();
    await page.waitForFunction((before) => document.querySelectorAll('.scrimba-board .correct, .scrimba-board .present, .scrimba-board .absent').length > before, before);
  };
  await say(alice, '/scrimba');
  await panel(alice).waitFor();
  assert.equal(await panel(bob).count(), 0, 'Invitations do not open other clients automatically');
  await bob.getByText('Scrimba Alice has started a game of Scrimba. Click here to join', { exact: true }).waitFor();
  assert.equal(await outsider.evaluate(() => window.__messages.filter((m) => m.scrimbaId).length), 0);
  await bob.getByRole('button', { name: 'Launch Scrimba', exact: true }).click();
  await panel(bob).getByRole('button', { name: /Your board/ }).waitFor();
  const aliceID = await alice.evaluate(() => window.__selfId);
  const bobID = await bob.evaluate(() => window.__selfId);
  assert.equal((await latest(alice)).id, (await latest(bob)).id, 'Players share one puzzle');
  const apple = panel(alice).getByRole('button', { name: /^Add Apple/ });
  await apple.click();
  assert.equal(await apple.isDisabled(), true, 'Selected emojis cannot be reused in the same guess');
  await panel(alice).getByRole('button', { name: /Delete/ }).click();
  assert.equal(await apple.isEnabled(), true, 'Deleting an emoji makes it available again');
  await guess(alice, ['Apple', 'Lemon', 'Grapes', 'Star', 'Fire']);
  await panel(bob).getByRole('button', { name: /Scrimba Alice/ }).click();
  await bob.waitForFunction(() => document.querySelectorAll('.scrimba-cell').length === 30 && document.querySelector('.scrimba-cell').textContent === '?');
  const hidden = await latest(bob);
  assert.equal(hidden.solution, undefined);
  assert.equal(hidden.players.find((p) => p.id === aliceID).guesses[0].emojis, undefined, 'Unfinished clients never receive another player’s emojis');
  assert.equal(hidden.players.find((p) => p.id === bobID).guesses.length, 0, 'Progress remains independent');
  assert.equal(await board(bob).locator('.scrimba-cell').first().textContent(), '?');
  await alice.screenshot({ path: `${output}/scrimba-desktop.png`, fullPage: true });
  await bob.setViewportSize({ width: 390, height: 844 });
  await bob.screenshot({ path: `${output}/scrimba-mobile.png`, fullPage: true });
  const bounds = await panel(bob).boundingBox();
  assert(bounds && bounds.x >= 0 && bounds.x + bounds.width <= 390 && bounds.y >= 0 && bounds.y + bounds.height <= 844, 'Mobile game fits screen');
  await panel(bob).getByRole('button', { name: /Your board/ }).click();
  await bob.screenshot({ path: `${output}/scrimba-mobile-keyboard.png`, fullPage: true });
  // Six distinct-emoji guesses exercise completion and reveal other boards.
  for (let turn = 0; turn < 6; turn++) {
    const me = (await latest(bob)).players.find((p) => p.id === bobID);
    if (me.done) break;
    const available = await panel(bob).locator('.scrimba-keyboard button:enabled').evaluateAll((buttons) => buttons.slice(0, 5).map((button) => button.getAttribute('aria-label').slice(4).split(',')[0]));
    await guess(bob, available);
    const keys = panel(bob).locator('.scrimba-keyboard button.absent');
    for (let i = 0; i < await keys.count(); i++) assert.equal(await keys.nth(i).isDisabled(), true, 'Confirmed absent emojis cannot be selected');
  }
  await panel(bob).getByText(/Solution:/).waitFor();
  const completed = await latest(bob);
  assert.equal(completed.solution.length, 5);
  assert.equal(new Set(completed.solution).size, 5, 'Solutions contain unique emojis');
  assert.equal(completed.players.find((p) => p.id === aliceID).guesses[0].emojis.length, 5);
  await panel(bob).getByRole('button', { name: /Scrimba Alice/ }).click();
  assert.equal(await board(bob).locator('.scrimba-cell').first().textContent(), '🍎');
  // Complete the starter's board using the common solution disclosed to Bob.
  const names = { '🍎': 'Apple', '🍋': 'Lemon', '🍇': 'Grapes', '🍒': 'Cherries', '🥝': 'Kiwi', '🌸': 'Blossom', '🌻': 'Sunflower', '🍀': 'Clover', '🔥': 'Fire', '⭐': 'Star', '🌈': 'Rainbow', '💎': 'Gem' };
  if (!(await latest(alice)).players.find((p) => p.id === aliceID).done) {
    for (const emoji of completed.solution) await panel(alice).getByRole('button', { name: new RegExp('^Add ' + names[emoji]) }).click();
    await panel(alice).getByRole('button', { name: 'Guess', exact: true }).click();
  }
  await panel(alice).getByText('You solved it! 🎉', { exact: true }).waitFor();
  assert.deepEqual((await latest(alice)).solution, completed.solution);
  await alice.screenshot({ path: `${output}/scrimba-solved.png`, fullPage: true });
  // Closing does not reset progress; invitations can reopen a finished board.
  await panel(alice).getByRole('button', { name: 'Close Scrimba', exact: true }).click();
  await go(alice, { x: 504, y: 408 });
  await go(alice, { x: 504, y: 312 });
  assert.equal(await alice.getByRole('button', { name: 'Launch Scrimba', exact: true }).count(), 0, 'Chat history stays cleared');
  await alice.getByRole('button', { name: 'Resume Scrimba 1', exact: true }).click();
  await panel(alice).getByText('You solved it! 🎉', { exact: true }).waitFor();
  const finishedID = (await latest(alice)).id;
  await alice.evaluate((id) => window.__gameSocket.send(JSON.stringify({ type: 'scrimba-guess', id, turn: 0, emojis: [] })), finishedID);
  await panel(alice).getByRole('alert').filter({ hasText: 'this Scrimba guess is no longer available' }).waitFor();
  await alice.keyboard.press('Escape');
  await panel(alice).waitFor({ state: 'hidden' });
  await panel(bob).getByRole('button', { name: 'Close Scrimba', exact: true }).click();
  await say(alice, 'Back to chat');
  await bob.getByRole('log', { name: 'Carpet messages' }).getByText('Back to chat', { exact: true }).waitFor();
  // Office reconnects use a new player identity. Old private boards must not
  // leak into the automatically rejoined session or prevent new games.
  const previousID = await alice.evaluate(() => window.__selfId);
  await alice.evaluate(() => window.__gameSocket.close());
  await alice.waitForFunction((oldID) => window.__selfId !== oldID && document.querySelector('[data-testid="game-canvas"]')?.dataset.carpet, previousID);
  assert.equal(await alice.getByRole('button', { name: /^Resume Scrimba/ }).count(), 0, 'A new identity has no previous private boards');
  await say(alice, '/scrimba');
  await panel(alice).getByRole('button', { name: /Your board/ }).waitFor();
  assert.equal((await latest(alice)).players[0].guesses.length, 0, 'A rejoined identity can start a fresh game');
  assert.deepEqual(errors, []);
  console.log('Scrimba browser checks passed: launch, join, shared puzzle, independent progress, server redaction, completion, reopen, chat, mobile layout.');
} finally {
  await Promise.all(contexts.map((context) => context.close()));
  await browser.close();
}
