import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';

const browser = await chromium.launch({
  executablePath: process.env.CHROME_PATH || undefined,
  headless: true,
  args: ['--no-sandbox', '--disable-background-timer-throttling', '--disable-renderer-backgrounding'],
});
const errors = [];
async function join(name) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  await context.addInitScript(() => {
    window.__emojiDraws = {};
    const fillText = CanvasRenderingContext2D.prototype.fillText;
    CanvasRenderingContext2D.prototype.fillText = function(text, ...args) {
      if (['👋', '👍', '❤️', '😂', '🎉', '🤔'].includes(text)) window.__emojiDraws[text] = performance.now();
      return fillText.call(this, text, ...args);
    };
  });
  const page = await context.newPage();
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(process.env.BESPINGLE_URL || 'http://127.0.0.1:5555');
  await page.getByLabel('Your display name').fill(name);
  await page.getByRole('button', { name: 'Enter the office', exact: true }).click();
  await page.getByRole('button', { name: 'Edit profile', exact: true }).waitFor();
  return page;
}

try {
  const sender = await join('Emoji sender');
  const observer = await join('Emoji observer');
  assert.equal(await sender.getByRole('group', { name: 'Emoji reactions' }).getByRole('button').count(), 6);
  await sender.getByRole('button', { name: 'React: Wave', exact: true }).click();
  for (const page of [sender, observer]) {
    await page.waitForFunction(() => window.__emojiDraws['👋'] > 0);
  }
  await mkdir('test-results/browser', { recursive: true });
  await sender.screenshot({ path: 'test-results/browser/emoji-desktop.png' });
  await sender.waitForTimeout(300);
  await sender.getByRole('button', { name: 'React: Love', exact: true }).focus();
  await sender.keyboard.press('Enter');
  for (const page of [sender, observer]) {
    await page.waitForFunction(() => window.__emojiDraws['❤️'] > 0);
    await page.waitForFunction(() => performance.now() - window.__emojiDraws['❤️'] > 600, null, { timeout: 5000 });
  }
  await sender.setViewportSize({ width: 390, height: 844 });
  await sender.getByRole('button', { name: 'React: Celebrate', exact: true }).click();
  await sender.waitForFunction(() => window.__emojiDraws['🎉'] > 0);
  const buttons = sender.getByRole('group', { name: 'Emoji reactions' }).getByRole('button');
  for (const button of await buttons.all()) {
    const bounds = await button.boundingBox();
    assert.ok(bounds && bounds.x >= 0 && bounds.x + bounds.width <= 390 && bounds.y + bounds.height <= 844, 'emoji buttons fit on mobile');
  }
  await sender.screenshot({ path: 'test-results/browser/emoji-mobile.png' });
  assert.deepEqual(errors, []);
  console.log('Emoji reactions passed: six buttons, sender/observer rendering, keyboard activation, expiry, and mobile layout.');
} finally {
  await browser.close();
}
