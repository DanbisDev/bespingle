import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
await mkdir('test-results', { recursive: true });
const url = process.env.BESPINGLE_URL || 'http://127.0.0.1:5555';
const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || undefined, headless: true, args: ['--no-sandbox', '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--autoplay-policy=no-user-gesture-required'] });
// Mirroring is display-only, so it shows as a transform on the video element.
const mirrored = (page, selector) => page.locator(selector).first().evaluate((video) => getComputedStyle(video).transform.startsWith('matrix(-1'));
try {
  const context = await browser.newContext({ permissions: ['camera', 'microphone'], viewport: { width: 1280, height: 800 } });
  await context.addInitScript(() => {
    navigator.mediaDevices.getDisplayMedia = async () => {
      const canvas = document.createElement('canvas'); canvas.width = 640; canvas.height = 360;
      const ctx = canvas.getContext('2d'); ctx.fillStyle = '#113c52'; ctx.fillRect(0, 0, 640, 360);
      return canvas.captureStream(5);
    };
  });
  const page = await context.newPage();
  page.on('pageerror', (e) => console.error('PAGE ERROR', e));
  const enter = async () => {
    await page.goto(url);
    await page.getByLabel('Your display name').fill('Mirror test');
    await page.getByRole('button', { name: 'Enter the office', exact: true }).click();
    await page.getByRole('button', { name: 'Turn camera on', exact: true }).click();
    await page.getByRole('button', { name: 'Turn camera off', exact: true }).waitFor({ timeout: 45000 });
    await page.locator('[data-testid="game-canvas"]').focus();
    await page.keyboard.down('w');
    await page.locator('.call-strip.has-conversation').waitFor();
    await page.keyboard.up('w');
    await page.locator('[data-testid="video-self"].has-video').waitFor();
  };
  const settings = () => page.getByRole('button', { name: 'Audio and video settings', exact: true }).click();
  const toggle = () => page.getByRole('checkbox', { name: 'Mirror my video' });
  const done = () => page.getByRole('button', { name: 'Done', exact: true }).click();
  const strip = '[data-testid="video-self"] video';

  await enter();
  assert(await mirrored(page, strip), 'A fresh browser mirrors the strip self-view');
  await settings();
  assert(await toggle().isChecked(), 'Mirroring defaults to on');
  assert(await mirrored(page, '.self-view-preview video'), 'Settings preview is mirrored');
  assert.equal(await page.locator('.background-preview').count(), 0, 'Settings preview does not reuse the background-preview hook');
  await toggle().uncheck();
  assert(!await mirrored(page, '.self-view-preview video'), 'Turning mirroring off un-flips the settings preview at once');
  assert(!await mirrored(page, strip), 'Turning mirroring off un-flips the strip at once');
  await done();
  await page.getByRole('button', { name: 'Camera background', exact: true }).click();
  assert(!await mirrored(page, '.background-preview video'), 'Camera background preview follows the setting');
  await done();
  await page.getByRole('button', { name: 'Enlarge conversation videos', exact: true }).click();
  await page.locator('.expanded .gallery').waitFor();
  assert(!await mirrored(page, '.expanded .gallery [data-testid="video-self"] video'), 'Gallery self-view follows the setting');
  await page.getByRole('button', { name: 'Pin Mirror test (you) video', exact: true }).click();
  await page.locator('.expanded [data-testid="video-self"].is-selected').waitFor();
  assert(!await mirrored(page, '.expanded [data-testid="video-self"].is-selected video'), 'Expanded self-view follows the setting');
  await page.getByRole('button', { name: 'Return to game', exact: true }).click();
  console.log('Turning mirroring off un-flips every self-view at once');

  await enter();
  assert(!await mirrored(page, strip), 'The off choice survives a reload');
  await settings();
  assert(!await toggle().isChecked(), 'The control shows the remembered choice after a reload');
  await toggle().check();
  assert(await mirrored(page, '.self-view-preview video') && await mirrored(page, strip), 'Turning mirroring on flips again at once');
  await done();
  await page.getByRole('button', { name: 'Camera background', exact: true }).click();
  assert(await mirrored(page, '.background-preview video'), 'Camera background preview mirrors again');
  await done();
  console.log('The choice survives a reload and turning it on mirrors again');

  await page.getByRole('button', { name: 'Share screen', exact: true }).click();
  await page.locator('[data-testid="screen-self"].has-video').waitFor();
  assert(!await mirrored(page, '[data-testid="screen-self"] video'), 'Own screen share is not mirrored with mirroring on');
  await settings(); await toggle().uncheck(); await done();
  assert(!await mirrored(page, '[data-testid="screen-self"] video'), 'Own screen share is not mirrored with mirroring off');
  await settings(); await toggle().check(); await done();
  console.log('The own screen share is never mirrored');

  await page.getByRole('button', { name: 'Turn camera off', exact: true }).click();
  await page.getByRole('button', { name: 'Turn camera on', exact: true }).waitFor();
  await settings();
  assert.equal(await page.locator('.self-view-preview').count(), 0, 'No settings preview while the camera is off');
  assert(await toggle().isChecked(), 'The control stays available while the camera is off');
  await done();
  console.log('With the camera off the settings dialog has no preview');
  console.log('Self-view mirroring passed');
} catch (error) {
  for (const [index, page] of browser.contexts().flatMap((context) => context.pages()).entries()) await page.screenshot({ path: `test-results/mirror-failure-${index}.png` }).catch(() => {});
  throw error;
} finally {
  await browser.close();
}
