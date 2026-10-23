import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const output = fileURLToPath(new URL('../test-results/browser/', import.meta.url));
await mkdir(output, { recursive: true });
const browser = await chromium.launch({
  executablePath: process.env.CHROME_PATH || undefined,
  headless: true,
  args: ['--no-sandbox', '--disable-background-timer-throttling', '--disable-renderer-backgrounding'],
});
const errors = [];
const canvasSelector = '[data-testid="game-canvas"]';
const samePoint = (a, b) => a.x === b.x && a.y === b.y;

async function client(name) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
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
async function waitAt(page, point) {
  await page.waitForFunction(({ x, y }) => {
    const canvas = document.querySelector('[data-testid="game-canvas"]');
    return Number(canvas.dataset.x) === x && Number(canvas.dataset.y) === y && canvas.dataset.moving !== 'true' &&
      Number(canvas.dataset.renderX) === x && Number(canvas.dataset.renderY) === y;
  }, point, { timeout: 3000 });
}
async function focus(page) {
  await page.bringToFront();
  await page.locator(canvasSelector).focus();
}

async function portal(page, target) {
  await focus(page);
  // Zoom out so every destination is visible, including tiles far from self.
  await page.locator(canvasSelector).hover();
  await page.mouse.wheel(0, 3000);
  await page.waitForTimeout(100);
  const click = await page.locator(canvasSelector).evaluate((canvas, target) => {
    const bounds = canvas.getBoundingClientRect();
    return { x: bounds.left + Number(canvas.dataset.cameraX) + target.x * Number(canvas.dataset.zoom),
      y: bounds.top + Number(canvas.dataset.cameraY) + target.y * Number(canvas.dataset.zoom) };
  }, target);
  await page.mouse.dblclick(click.x, click.y);
  await page.waitForFunction(() => document.querySelector('[data-testid="game-canvas"]').dataset.portaling === 'true');
}
try {
  const alice = await client('Portal Alice');
  const bob = await client('Portal Bob');
  await alice.waitForFunction(() => window.__players.length === 2);
  const [a,b] = await Promise.all([state(alice), state(bob)]);
  await portal(alice,b);
  await alice.waitForFunction(() => window.__players.every((player) => player.move?.portal));
  const swapping = await alice.evaluate(() => window.__players);
  assert.equal(new Set(swapping.map((player) => player.move.startedAt)).size,1, 'Both avatars start simultaneously');
  assert.deepEqual(swapping.map((player) => player.move.portal).sort(), ['blue','orange']);
  await alice.waitForTimeout(350);
  const falling = await Promise.all([state(alice), state(bob)]);
  assert(samePoint(falling[0],a) && samePoint(falling[1],b), 'Both source tiles remain owned during the fall');
  await alice.screenshot({path: output + '/portal-swap-falling.png', fullPage: true});
  await alice.waitForFunction(() => {
    const self = window.__players.find((player) => player.id === window.__selfId);
    const canvas = document.querySelector('[data-testid="game-canvas"]');
    return self.move && Number(canvas.dataset.renderX) === self.move.toX;
  });
  await alice.screenshot({path: output + '/portal-swap-emerging.png', fullPage: true});
  await Promise.all([waitAt(alice,b),waitAt(bob,a)]);
  const target = {x:552,y:696};
  await portal(alice,target);
  await alice.waitForTimeout(350);
  const entering = await state(alice);
  assert.equal(entering.renderX,b.x, 'Portal travel never walks along the intervening floor');
  await alice.screenshot({path: output + '/portal-travel-falling.png', fullPage: true});
  await waitAt(alice,target);
  assert(samePoint(await state(bob),a),'Travel to empty floor leaves the other avatar in place');
  await alice.screenshot({path: output + '/portal-travel-landed.png', fullPage: true});
  assert.deepEqual(errors,[]);
  console.log('PASS portal travel, synchronized swap, and landing', {screenshots:output});
} finally {
  await browser.close();
}
