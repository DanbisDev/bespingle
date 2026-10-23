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
  const settings = () => page.getByRole('button', { name: 'Video settings', exact: true }).click();
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
  await page.getByRole('button', { name: 'Expand', exact: true }).click();
  await page.locator('.expanded .gallery').waitFor();
  assert(!await mirrored(page, '.expanded .gallery [data-testid="video-self"] video'), 'Gallery self-view follows the setting');
  await page.getByRole('button', { name: 'Pin Mirror test (you) video', exact: true }).click();
  await page.locator('.expanded [data-testid="video-self"].is-selected').waitFor();
  assert(!await mirrored(page, '.expanded [data-testid="video-self"].is-selected video'), 'Expanded self-view follows the setting');
  await page.getByRole('button', { name: 'Back to game', exact: true }).click();
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

  // A camera that is red on the left and blue on the right shows which way
  // round peers receive it. Blur keeps that split; a virtual background
  // would replace a frame with no person in it, so blur is the case checked.
  const senderContext = await browser.newContext({ permissions: ['camera', 'microphone'], viewport: { width: 1280, height: 800 } });
  await senderContext.addInitScript(() => {
    const capture = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
    navigator.mediaDevices.getUserMedia = async (options) => {
      if (!options?.video) return capture(options);
      const canvas = document.createElement('canvas'); canvas.width = 640; canvas.height = 360;
      const ctx = canvas.getContext('2d');
      const draw = () => { ctx.fillStyle = '#e01010'; ctx.fillRect(0, 0, 320, 360); ctx.fillStyle = '#1010e0'; ctx.fillRect(320, 0, 320, 360); };
      draw(); setInterval(draw, 100);
      const stream = canvas.captureStream(10);
      if (options.audio) for (const track of (await capture({ audio: options.audio })).getAudioTracks()) stream.addTrack(track);
      return stream;
    };
  });
  const sender = await senderContext.newPage();
  sender.on('pageerror', (e) => console.error('PAGE ERROR', e));
  await sender.goto(url);
  await sender.getByLabel('Your display name').fill('Mirror sender');
  await sender.getByRole('button', { name: 'Enter the office', exact: true }).click();
  await sender.getByRole('button', { name: 'Turn camera on', exact: true }).click();
  await sender.getByRole('button', { name: 'Turn camera off', exact: true }).waitFor({ timeout: 45000 });
  await sender.locator('[data-testid="game-canvas"]').focus();
  await sender.keyboard.down('w');
  await sender.locator('.call-strip.has-conversation').waitFor();
  await sender.keyboard.up('w');
  const receiver = await (await browser.newContext({ viewport: { width: 1280, height: 800 } })).newPage();
  await receiver.goto(url);
  await receiver.getByLabel('Your display name').fill('Mirror receiver');
  await receiver.getByRole('button', { name: 'Enter the office', exact: true }).click();
  await receiver.getByRole('button', { name: 'Edit profile', exact: true }).waitFor();
  await receiver.waitForFunction(() => Number(document.querySelector('[data-testid="game-canvas"]').dataset.x) > 0);
  const game = receiver.locator('[data-testid="game-canvas"]');
  await game.focus();
  for (let i = 0; i < 2; i++) {
    const x = Number(await game.getAttribute('data-x')) - 48;
    await receiver.keyboard.down('a'); await receiver.waitForTimeout(35); await receiver.keyboard.up('a');
    await receiver.waitForFunction((x) => Number(document.querySelector('[data-testid="game-canvas"]').dataset.x) === x && document.querySelector('[data-testid="game-canvas"]').dataset.moving !== 'true', x);
  }
  await receiver.keyboard.down('w');
  await receiver.getByRole('dialog').waitFor(); await receiver.keyboard.up('w');
  await receiver.getByRole('button', { name: 'Neither', exact: false }).click();
  const peerSeesTrueImage = async (label) => {
    await receiver.waitForFunction(() => {
      const video = document.querySelector('[data-testid="video-peer"] video');
      if (!video?.videoWidth) return false;
      const canvas = document.createElement('canvas'); canvas.width = 20; canvas.height = 20;
      const ctx = canvas.getContext('2d'); ctx.drawImage(video, 0, 0, 20, 20);
      const [lr, , lb] = ctx.getImageData(2, 10, 1, 1).data; const [rr, , rb] = ctx.getImageData(17, 10, 1, 1).data;
      return lr > lb + 80 && rb > rr + 80;
    }, null, { timeout: 30000 }).catch(() => assert.fail(`${label}: the peer receives the camera un-mirrored`));
    assert(!await mirrored(receiver, '[data-testid="video-peer"] video'), `${label}: the peer's tile is not mirrored`);
  };
  const senderToggle = sender.getByRole('checkbox', { name: 'Mirror my video' });
  const setSenderMirror = async (on) => {
    await sender.getByRole('button', { name: 'Video settings', exact: true }).click();
    await senderToggle.setChecked(on);
    await sender.getByRole('button', { name: 'Done', exact: true }).click();
    assert.equal(await mirrored(sender, '[data-testid="video-self"] video'), on, 'The sender sees the chosen self-view');
  };
  for (const background of ['none', 'blur']) {
    if (background === 'blur') {
      await sender.getByRole('button', { name: 'Camera background', exact: true }).click();
      await sender.getByRole('button', { name: 'Blur', exact: true }).click();
      await sender.locator('.background-blur[aria-pressed="true"]').waitFor({ timeout: 45000 });
      await sender.getByRole('button', { name: 'Done', exact: true }).click();
    }
    for (const on of [true, false]) {
      await setSenderMirror(on);
      await peerSeesTrueImage(`Mirroring ${on ? 'on' : 'off'}, ${background === 'none' ? 'no background' : 'blur'}`);
    }
  }
  console.log('Peers receive the true image with mirroring on and off, with and without blur');
  console.log('Self-view mirroring passed');
} catch (error) {
  for (const [index, page] of browser.contexts().flatMap((context) => context.pages()).entries()) await page.screenshot({ path: `test-results/mirror-failure-${index}.png` }).catch(() => {});
  throw error;
} finally {
  await browser.close();
}
