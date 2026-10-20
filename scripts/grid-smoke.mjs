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
const keyCodes = { w: 'KeyW', a: 'KeyA', s: 'KeyS', d: 'KeyD' };
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
async function serverPlayer(page) {
  return page.evaluate(() => window.__players.find((player) => player.id === window.__selfId));
}
async function waitAt(page, point) {
  await page.waitForFunction(({ x, y }) => {
    const canvas = document.querySelector('[data-testid="game-canvas"]');
    return Number(canvas.dataset.x) === x && Number(canvas.dataset.y) === y && canvas.dataset.moving !== 'true';
  }, point, { timeout: 3000 });
}
async function waitIdle(page) {
  const idle = () => {
    const canvas = document.querySelector('[data-testid="game-canvas"]');
    const self = window.__players.find((player) => player.id === window.__selfId);
    const moves = window.__sent.filter((message) => message.type === 'move');
    const results = new Map(window.__messages.filter((message) => message.type === 'move-result').map((message) => [message.requestId, message]));
    if (!self || self.move || moves.some((move) => !results.has(move.requestId))) return false;
    // An acknowledgement may arrive before its state frame. For the latest
    // accepted request, wait for that destination's authoritative landing.
    const lastMove = moves.at(-1);
    if (lastMove && !lastMove.sprint && results.get(lastMove.requestId).accepted && (self.x !== lastMove.x || self.y !== lastMove.y)) return false;
    return canvas.dataset.moving !== 'true' && canvas.dataset.bouncing !== 'true' &&
      Number(canvas.dataset.x) === self.x && Number(canvas.dataset.y) === self.y &&
      Number(canvas.dataset.renderX) === self.x && Number(canvas.dataset.renderY) === self.y;
  };
  await page.waitForFunction(idle, null, { timeout: 5000 });
  await page.evaluate(() => new Promise(requestAnimationFrame));
  await page.waitForFunction(idle, null, { timeout: 5000 });
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
async function bounce(page, key) {
  const before = await state(page);
  await focus(page);
  await page.keyboard.down(key);
  try {
    await page.waitForFunction((count) => Number(document.querySelector('[data-testid="game-canvas"]').dataset.bounceCount) > count, before.bounceCount, { timeout: 1500 });
  } finally {
    await page.keyboard.up(key);
  }
  await page.waitForFunction(() => document.querySelector('[data-testid="game-canvas"]').dataset.bouncing === 'true');
  await page.waitForFunction(({ x, y }) => {
    const canvas = document.querySelector('[data-testid="game-canvas"]');
    return canvas.dataset.bouncing === 'true' && Math.hypot(Number(canvas.dataset.renderX) - x, Number(canvas.dataset.renderY) - y) > 0.5;
  }, before);
  const during = await state(page);
  assert(samePoint(before, during), 'A rejected move keeps ownership of the source tile');
  await page.waitForFunction(() => document.querySelector('[data-testid="game-canvas"]').dataset.bouncing !== 'true');
  const after = await state(page);
  assert(samePoint(before, after), 'A bounce returns to the original tile');
  assert.equal(after.renderX, before.x);
  assert.equal(after.renderY, before.y);
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
  const alice = await client('Grid Alice');
  const bob = await client('Grid Bob');
  await alice.waitForFunction(() => window.__players.length === 2);
  const initial = await Promise.all([state(alice), state(bob)]);
  assert(!samePoint(...initial), 'Simultaneous users spawn on different tiles');
  for (const player of initial) {
    assert.equal((player.x - grid.originX) % grid.size, 0);
    assert.equal((player.y - grid.originY) % grid.size, 0);
    assert.equal(player.col, (player.x - grid.originX) / grid.size);
    assert.equal(player.row, (player.y - grid.originY) / grid.size);
  }
  console.log('Unique tile-centered joins passed', initial);

  // Spawn tie-breaking may choose any nearest free neighbor; clear the tap lane.
  await go(bob, { x: 552, y: 696 });
  const beforeSprint = await state(alice);
  await focus(alice);
  await alice.keyboard.down('Shift');
  await alice.keyboard.down('d');
  try {
    await alice.waitForFunction(() => document.querySelector('[data-testid="game-canvas"]').dataset.moving === 'true');
  } finally {
    await alice.keyboard.up('d');
    await alice.keyboard.up('Shift');
  }
  const sprinting = await serverPlayer(alice);
  assert.equal(sprinting.move.toX, beforeSprint.x + 3 * grid.size, 'Shift moves three tiles per tick');
  assert.equal(sprinting.move.durationMs, grid.stepDurationMs, 'Sprint uses the same tick duration as walking');
  await waitAt(alice, { x: beforeSprint.x + 3 * grid.size, y: beforeSprint.y });
  await waitIdle(alice);
  await alice.screenshot({ path: output + '/10-sprint-controls.png', fullPage: true });
  await go(alice, { x: beforeSprint.x, y: beforeSprint.y });
  console.log('Shift sprint covers three tiles per tick and releasing Shift restores walking');

  const beforeTap = await state(alice);
  await step(alice, 'd', async (before, target) => {
    await alice.waitForFunction(({ from, to }) => {
      const canvas = document.querySelector('[data-testid="game-canvas"]');
      const rendered = Number(canvas.dataset.renderX);
      return canvas.dataset.moving === 'true' && rendered > from + 1 && rendered < to - 1;
    }, { from: before.x, to: target.x });
    const during = await state(alice);
    assert(samePoint(before, during), 'The source tile remains owned during animation');
    assert(during.renderX > before.x && during.renderX < target.x, 'Smooth movement renders intermediate positions');
    const authoritative = await serverPlayer(alice);
    assert.equal(authoritative.x, before.x, 'The server retains the source coordinate until landing');
    assert.equal(authoritative.move.toX, target.x, 'The destination is reserved during travel');
    // Re-deliver current geometry with a stale timestamp while the step is
    // underway. Clock synchronization must not drag smooth motion backwards.
    await alice.waitForTimeout(70);
    const delayedClock = await alice.evaluate(async () => {
      const canvas = document.querySelector('[data-testid="game-canvas"]');
      const before = Number(canvas.dataset.renderX);
      const latest = window.__messages.findLast((message) => Number.isFinite(message.serverNow));
      const staleServerNow = latest.serverNow - 150;
      window.__gameSocket.dispatchEvent(new MessageEvent('message', { data: JSON.stringify({
        type: 'state', players: window.__players, serverNow: staleServerNow,
      }) }));
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      return { before, after: Number(canvas.dataset.renderX), moving: canvas.dataset.moving === 'true' };
    });
    assert(delayedClock.before > before.x && delayedClock.before < target.x, 'The stale clock sample arrives during an active step');
    assert(delayedClock.after >= delayedClock.before, 'A delayed server clock sample cannot rewind rendered movement');
  });
  assert.equal((await state(alice)).x, beforeTap.x + grid.size, 'A quick tap advances exactly one tile');
  await alice.waitForTimeout(grid.stepDurationMs + 50);
  assert.equal((await state(alice)).x, beforeTap.x + grid.size, 'A released tap does not queue another tile');

  await focus(alice);
  const beforeHeld = await state(alice);
  await alice.keyboard.down('d');
  await alice.waitForTimeout(grid.stepDurationMs * 2.5);
  await alice.keyboard.up('d');
  await waitIdle(alice);
  const afterHeld = await state(alice);
  assert(afterHeld.x - beforeHeld.x >= grid.size * 2, 'Holding a key continues walking tile by tile');
  assert.equal((afterHeld.x - beforeHeld.x) % grid.size, 0);
  assert.equal(afterHeld.y, beforeHeld.y);

  const sentBefore = await alice.evaluate(() => window.__sent.length);
  await alice.keyboard.down('w');
  await alice.keyboard.down('d');
  await alice.waitForTimeout(grid.stepDurationMs * 1.5);
  await alice.keyboard.up('d');
  await alice.keyboard.up('w');
  await waitIdle(alice);
  const diagonalMoves = await alice.evaluate((start) => window.__sent.slice(start).filter((message) => message.type === 'move'), sentBefore);
  console.log('Cardinal movement snapshots', JSON.stringify({ beforeHeld, afterHeld, sentBefore, diagonalMoves, settled: await state(alice) }));
  assert(diagonalMoves.length >= 1);
  let previous = afterHeld;
  for (const move of diagonalMoves) {
    assert.equal(Math.abs(move.x - previous.x) + Math.abs(move.y - previous.y), grid.size, 'Multiple held keys still move one cardinal tile at a time');
    previous = move;
  }
  console.log('Tap, smooth interpolation, held repeat, and cardinal movement passed');

  await go(alice, { x: 648, y: 696 });
  await go(bob, { x: 600, y: 696 });
  const bobBeforeBounce = await state(bob);
  await bounce(alice, 'a');
  assert(samePoint(bobBeforeBounce, await state(bob)), 'An occupied-tile collision moves only the walking player');
  assert(await alice.evaluate(() => window.__messages.some((message) => message.type === 'move-result' && message.reason === 'occupied')), 'The server rejects an occupied tile');

  await go(bob, { x: 552, y: 696 });
  const raceCounts = await Promise.all([alice, bob].map((page) => page.evaluate(() => window.__messages.length)));
  await Promise.all([[alice, 'a'], [bob, 'd']].map(([page, key]) => page.evaluate(({ code, key }) => {
    window.dispatchEvent(new KeyboardEvent('keydown', { code, key, bubbles: true }));
  }, { code: keyCodes[key], key })));
  await new Promise((resolve) => setTimeout(resolve, 60));
  await Promise.all([[alice, 'a'], [bob, 'd']].map(([page, key]) => page.evaluate(({ code, key }) => {
    window.dispatchEvent(new KeyboardEvent('keyup', { code, key, bubbles: true }));
  }, { code: keyCodes[key], key })));
  await Promise.all([alice, bob].map(waitIdle));
  const racePositions = await Promise.all([state(alice), state(bob)]);
  assert.equal(racePositions.filter((player) => player.x === 600 && player.y === 696).length, 1, 'Only one simultaneous contender claims the tile');
  assert(!samePoint(...racePositions), 'The losing contender remains on a distinct tile');
  const raceResults = (await Promise.all([alice, bob].map((page, index) => page.evaluate((start) => window.__messages.slice(start).filter((message) => message.type === 'move-result'), raceCounts[index])))).flat();
  assert.equal(raceResults.filter((result) => result.accepted).length, 1, 'The server accepts only one simultaneous tile claim');
  console.log('Occupied-tile bounce and simultaneous destination reservation passed');

  const studio = world.carpets.find((carpet) => carpet.id === 'studio');
  const studioChair = world.chairs.find((chair) => chair.id === 'studio-1');
  const floorY = grid.originY + Math.ceil((studio.y + studio.h - grid.originY) / grid.size) * grid.size;
  await go(alice, { x: studioChair.x, y: floorY });
  assert.equal((await state(alice)).carpet, '', 'The approach tile is on the open floor');
  await step(alice, 'w', async () => {
    assert.equal((await state(alice)).carpet, '', 'Carpet membership stays on the source tile until landing');
    assert.equal((await serverPlayer(alice)).carpetId, '', 'The server also waits for landing before joining a call');
    assert.equal(await alice.getByRole('dialog').count(), 0, 'The media prompt waits for landing');
  });
  await alice.getByRole('dialog').waitFor();
  assert.equal((await state(alice)).carpet, studio.id);
  await dismissPrompt(alice);
  await go(alice, { x: studioChair.x, y: studioChair.y + grid.size });
  assert.equal((await serverPlayer(alice)).seated, false);
  await step(alice, 'w', async () => {
    assert.equal((await serverPlayer(alice)).seated, false, 'The avatar sits only after landing on a chair tile');
  });
  await alice.waitForFunction(() => window.__players.find((player) => player.id === window.__selfId).seated);
  assert.equal((await state(alice)).carpet, studio.id, 'Chair seating preserves carpet ownership');
  await alice.screenshot({ path: output + '/14-grid-seating.png', fullPage: true });

  await go(alice, { x: 648, y: 72 });
  await bounce(alice, 'w');
  console.log('Landing-based carpet entry, chair seating, and solid wall blocking passed');
  assert.deepEqual(errors, [], 'No uncaught browser errors');
  console.log('PASS grid movement', JSON.stringify({ screenshots: output, browserErrors: errors }));
} catch (error) {
  for (let index = 0; index < contexts.length; index++) {
    const page = contexts[index].pages()[0];
    await page.screenshot({ path: output + '/grid-failure-' + index + '.png', fullPage: true }).catch(() => {});
    console.log('Grid diagnostics ' + index, JSON.stringify({
      canvas: await state(page).catch(() => null),
      messages: await page.evaluate(() => window.__messages.slice(-10)).catch(() => []),
      sent: await page.evaluate(() => window.__sent.slice(-10)).catch(() => []),
      text: await page.locator('body').innerText().catch(() => ''),
    }));
  }
  throw error;
} finally {
  await browser.close();
}
