import { chromium } from 'playwright';
import assert from 'node:assert/strict';

const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || undefined, headless: true, args: ['--no-sandbox', '--disable-background-timer-throttling', '--disable-renderer-backgrounding'] });
const errors = [];
async function join(name) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  await context.addInitScript(() => {
    window.__danceStates = [];
    const NativeSocket = window.WebSocket;
    window.WebSocket = class extends NativeSocket {
      constructor(...args) {
        super(...args);
        this.addEventListener('message', ({ data }) => {
          const message = JSON.parse(data);
          if (message.players) window.__danceStates = message.players;
        });
      }
    };
  });
  const page = await context.newPage();
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(process.env.BESPINGLE_URL || 'http://127.0.0.1:5555');
  await page.getByLabel('Your display name').fill(name);
  await page.getByRole('button', { name: 'Enter the office', exact: true }).click();
  await page.getByRole('button', { name: 'Edit profile', exact: true }).waitFor();
  return page;
}
try {
  const dancer = await join('Dancer');
  const observer = await join('Observer');
  const canvas = dancer.getByTestId('game-canvas');
  await dancer.bringToFront();
  await canvas.focus();
  await dancer.keyboard.down('z');
  await dancer.waitForFunction(() => document.querySelector('canvas[data-testid="game-canvas"]').dataset.dancing === 'true');
  await observer.waitForFunction(() => window.__danceStates.some(p => p.name === 'Dancer' && p.dance));
  await dancer.keyboard.down('z'); // OS key repeat must not toggle the dance off.
  await dancer.waitForTimeout(250);
  assert.equal(await canvas.getAttribute('data-dancing'), 'true');
  await dancer.keyboard.up('z');
  await dancer.screenshot({ path: 'test-results/browser/dance.png' });
  await dancer.keyboard.press('z');
  await dancer.waitForFunction(() => document.querySelector('canvas[data-testid="game-canvas"]').dataset.dancing === 'false');
  await dancer.keyboard.press('z');
  await dancer.waitForFunction(() => document.querySelector('canvas[data-testid="game-canvas"]').dataset.dancing === 'true');
  await dancer.keyboard.press('ArrowUp');
  await dancer.waitForFunction(() => document.querySelector('canvas[data-testid="game-canvas"]').dataset.dancing === 'false');
  await observer.waitForFunction(() => window.__danceStates.some(p => p.name === 'Dancer' && !p.dance));
  // Profile inputs must retain normal typing, without triggering a dance.
  await dancer.getByRole('button', { name: 'Edit profile', exact: true }).click();
  await dancer.getByLabel('Display name', { exact: true }).fill('');
  await dancer.getByLabel('Display name', { exact: true }).press('z');
  assert.equal(await dancer.getByLabel('Display name', { exact: true }).inputValue(), 'z');
  assert.equal(await canvas.getAttribute('data-dancing'), 'false');
  assert.deepEqual(errors, []);
  console.log('Dance passed: Z toggle, repeat guard, observer sync, walking cancellation, and typing guard.');
} finally {
  await browser.close();
}
