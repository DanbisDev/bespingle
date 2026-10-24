import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { chromium } from 'playwright';

const base = process.env.AVATAR_TEST_URL;
if (!base) throw new Error('Run through npm run test:avatars after npm run build.');
const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || undefined, headless: true, args: ['--no-sandbox'] });
const errors = [];
try {
  const owner = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await owner.newPage();
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(base);
  await page.getByRole('textbox', { name: 'Your display name' }).fill('Avatar Designer');
  assert.equal(await page.locator('.avatar-option').count(), 6);
  await page.getByText('Create your own with Claude or Codex', { exact: true }).click();
  await page.getByRole('button', { name: 'Generate upload code', exact: true }).click();
  const prompt = page.getByRole('textbox', { name: /Agent prompt/ });
  await prompt.waitFor();
  const token = (await prompt.inputValue()).match(/uploadCode "([a-f0-9]{64})"/)[1];
  const pngBase64 = await page.evaluate(() => {
    const sheet = document.createElement('canvas'); sheet.width = 384; sheet.height = 256;
    const ctx = sheet.getContext('2d');
    for (let row = 0; row < 4; row++) for (let col = 0; col < 6; col++) {
      ctx.fillStyle = '#ff3366'; ctx.fillRect(col * 64 + 16, row * 64 + 12, 32, 46);
      ctx.fillStyle = '#ffffff'; ctx.fillRect(col * 64 + 22, row * 64 + 20, 6, 6);
    }
    return sheet.toDataURL('image/png').split(',')[1];
  });
  // Emulate an agent using the actual HTTP MCP transport, not a mocked route.
  const rpc = async (id, method, params) => {
    const response = await owner.request.post(`${base}/mcp`, { headers: { Accept: 'application/json, text/event-stream', 'MCP-Protocol-Version': '2025-06-18' }, data: { jsonrpc: '2.0', id, method, params } });
    assert.equal(response.status(), 200, await response.text());
    const result = await response.json(); assert(!result.error, JSON.stringify(result)); return result.result;
  };
  await rpc(1, 'initialize', { protocolVersion: '2025-06-18', clientInfo: { name: 'browser-smoke-agent', version: '1' }, capabilities: {} });
  assert.equal((await rpc(2, 'tools/list', {})).tools.length, 2);
  const result = await rpc(3, 'tools/call', { name: 'upload_avatar', arguments: { uploadCode: token, pngBase64 } });
  assert(!result.isError, JSON.stringify(result));
  const id = result.structuredContent.avatarId;
  const custom = page.getByRole('button', { name: 'Your custom avatar', exact: true });
  await custom.waitFor(); assert.equal(await custom.getAttribute('aria-pressed'), 'true');
  await page.waitForFunction(() => {
    const ctx = document.querySelector('.welcome-pixel canvas')?.getContext('2d');
    const pixel = ctx?.getImageData(48, 44, 1, 1).data;
    return pixel?.[0] === 255 && pixel?.[1] === 51;
  });
  await mkdir('test-results/browser', { recursive: true });
  await page.screenshot({ path: 'test-results/browser/custom-avatar-selector.png' });
  await page.getByRole('button', { name: 'Enter the office' }).click();
  await page.getByRole('button', { name: 'Edit profile', exact: true }).waitFor();
  let cookies = await owner.cookies();
  const cookie = cookies.find((item) => item.name === 'bespingle_profile');
  assert.equal(cookie.sameSite, 'Lax'); assert(cookie.expires > Date.now() / 1000 + 300 * 86400);
  assert.equal(JSON.parse(decodeURIComponent(cookie.value)).customAvatar, id);
  // A different browser sees the worn avatar in office state, but no custom selector entry.
  const stranger = await browser.newContext(); const other = await stranger.newPage(); await other.goto(base);
  assert.equal(await other.locator('.avatar-option').count(), 6);
  assert.equal(await other.getByRole('button', { name: 'Your custom avatar', exact: true }).count(), 0);
  await page.getByRole('button', { name: 'Edit profile', exact: true }).click();
  await page.getByRole('textbox', { name: 'Display name', exact: true }).fill('Saved Designer');
  await page.getByRole('button', { name: 'Save profile' }).click();
  // Leaving first, so the reload shows the join form rather than rejoining.
  await page.getByRole('button', { name: 'Leave office', exact: true }).click();
  await page.reload();
  await page.getByRole('textbox', { name: 'Your display name' }).waitFor();
  assert.equal(await page.getByRole('textbox', { name: 'Your display name' }).inputValue(), 'Saved Designer');
  assert.equal(await page.getByRole('button', { name: 'Your custom avatar', exact: true }).getAttribute('aria-pressed'), 'true');
  // Defaults remain available and choosing one clears only the selection, retaining the personal option.
  await page.getByRole('button', { name: 'Fern avatar', exact: true }).click();
  await page.getByRole('button', { name: 'Enter the office' }).click();
  await page.getByRole('button', { name: 'Edit profile', exact: true }).waitFor();
  cookies = await owner.cookies();
  const saved = JSON.parse(decodeURIComponent(cookies.find((item) => item.name === 'bespingle_profile').value));
  assert.equal(saved.customAvatar, ''); assert.equal(saved.customOption, id);

  // A sheet with three walk and five dance frames: every column has its own red
  // value and a green of 200, so a sampled pixel names the column drawn.
  await page.getByRole('button', { name: 'Edit profile', exact: true }).click();
  await page.getByText('Create your own with Claude or Codex', { exact: true }).click();
  await page.getByRole('button', { name: 'Generate upload code', exact: true }).click();
  const wideToken = (await page.getByRole('textbox', { name: /Agent prompt/ }).inputValue()).match(/uploadCode "([a-f0-9]{64})"/)[1];
  const widePng = await page.evaluate(() => {
    const sheet = document.createElement('canvas'); sheet.width = 64 * (2 + 3 + 5); sheet.height = 256;
    const ctx = sheet.getContext('2d');
    for (let row = 0; row < 4; row++) for (let col = 0; col < 10; col++) {
      ctx.fillStyle = `rgb(${40 + col * 16}, 200, 90)`; ctx.fillRect(col * 64 + 16, row * 64 + 12, 32, 46);
    }
    return sheet.toDataURL('image/png').split(',')[1];
  });
  const wide = await rpc(4, 'tools/call', { name: 'upload_avatar', arguments: { uploadCode: wideToken, pngBase64: widePng, walkFrames: 3, danceFrames: 5 } });
  assert(!wide.isError, JSON.stringify(wide));
  const wideId = wide.structuredContent.avatarId;
  assert.match(wideId, /^[a-f0-9]{64}-3-5$/);
  await page.waitForFunction(() => document.querySelector('[aria-label="Your custom avatar"]')?.getAttribute('aria-pressed') === 'true');
  const previewColumn = (selector) => page.evaluate((selector) => {
    const pixel = document.querySelector(selector)?.getContext('2d')?.getImageData(48, 44, 1, 1).data;
    return pixel?.[1] === 200 ? (pixel[0] - 40) / 16 : -1;
  }, selector);
  await page.waitForFunction(() => document.querySelector('.profile-preview canvas')?.getContext('2d')?.getImageData(48, 44, 1, 1).data[1] === 200);
  assert.equal(await previewColumn('.profile-preview canvas'), 0);
  assert.equal(await previewColumn('[aria-label="Your custom avatar"] canvas'), 0);
  await page.getByRole('button', { name: 'Save profile' }).click();
  await page.reload();
  await page.getByRole('textbox', { name: 'Your display name' }).waitFor();
  assert.equal(await page.getByRole('button', { name: 'Your custom avatar', exact: true }).getAttribute('aria-pressed'), 'true');
  await page.getByRole('button', { name: 'Enter the office' }).click();
  await page.getByRole('button', { name: 'Edit profile', exact: true }).waitFor();
  cookies = await owner.cookies();
  const wideSaved = JSON.parse(decodeURIComponent(cookies.find((item) => item.name === 'bespingle_profile').value));
  assert.equal(wideSaved.customAvatar, wideId); assert.equal(wideSaved.customOption, wideId);
  const canvas = page.getByTestId('game-canvas');
  await page.waitForFunction(() => document.querySelector('canvas[data-testid="game-canvas"]').dataset.avatarColumn === '0');
  // Record the column the office reports for this player, and the column its
  // pixels show, on every frame for a while.
  const record = (ms) => page.evaluate((ms) => new Promise((resolve) => {
    const game = document.querySelector('canvas[data-testid="game-canvas"]');
    const ctx = game.getContext('2d'); const samples = []; const end = performance.now() + ms;
    const tick = () => {
      const { avatarColumn, moving, dancing, renderX, renderY, cameraX, cameraY, zoom } = game.dataset;
      const dpr = game.width / game.clientWidth;
      const pixel = ctx.getImageData(Math.round((Number(cameraX) + Number(renderX) * Number(zoom)) * dpr), Math.round((Number(cameraY) + (Number(renderY) - 29) * Number(zoom)) * dpr), 1, 1).data;
      samples.push({ column: Number(avatarColumn), moving: moving === 'true', dancing: dancing === 'true', drawn: pixel[1] === 200 ? (pixel[0] - 40) / 16 : -1 });
      if (performance.now() < end) requestAnimationFrame(tick); else resolve(samples);
    };
    requestAnimationFrame(tick);
  }), ms);
  const inOrder = (columns, first, count) => columns.every((column, index) => index === 0 || column === columns[index - 1] || column === first + (columns[index - 1] - first + 1) % count);
  await canvas.focus();
  await page.keyboard.press('z');
  await page.waitForFunction(() => document.querySelector('canvas[data-testid="game-canvas"]').dataset.dancing === 'true');
  const dance = (await record(2000)).filter((sample) => sample.dancing);
  const danced = dance.map((sample) => sample.column);
  assert.deepEqual([...new Set(danced)].sort(), [5, 6, 7, 8, 9], JSON.stringify(danced));
  assert(inOrder(danced, 5, 5), `dance cells out of order: ${danced}`);
  assert.deepEqual([...new Set(dance.map((sample) => sample.drawn))].sort(), [5, 6, 7, 8, 9]);
  // Walking ends the dance and plays the three walk cells on this viewer's clock.
  const walk = [];
  for (const key of ['ArrowLeft', 'ArrowRight', 'ArrowDown', 'ArrowUp']) {
    await page.keyboard.down(key);
    walk.push(...(await record(1200)).filter((sample) => sample.moving));
    await page.keyboard.up(key);
    if (new Set(walk.map((sample) => sample.column)).size >= 3) break;
  }
  const walked = walk.map((sample) => sample.column).filter((column) => column !== 0);
  assert.deepEqual([...new Set(walked)].sort(), [1, 2, 3], JSON.stringify(walked));
  assert(walked.every((column) => column <= 3));
  await page.waitForFunction(() => document.querySelector('canvas[data-testid="game-canvas"]').dataset.avatarColumn === '0');
  await page.screenshot({ path: 'test-results/browser/custom-avatar-wide.png' });

  // A reference whose counts do not match its image's size falls back to the
  // chosen default avatar, in the selector and in the office.
  const mismatched = `${id}-3-5`;
  await owner.addCookies([{ ...cookies.find((item) => item.name === 'bespingle_profile'), value: encodeURIComponent(JSON.stringify({ ...wideSaved, customAvatar: mismatched, customOption: mismatched })) }]);
  await page.reload();
  await page.getByRole('textbox', { name: 'Your display name' }).waitFor();
  await page.waitForFunction((id) => performance.getEntriesByType('resource').some((entry) => entry.name.endsWith(`/api/avatars/${id}`)), id);
  await page.waitForTimeout(300);
  const fallback = await page.evaluate((avatar) => {
    const pixels = (selector) => Array.from(document.querySelector(selector).getContext('2d').getImageData(0, 0, 96, 96).data).join();
    return pixels('[aria-label="Your custom avatar"] canvas') === pixels(`.avatar-option:nth-child(${avatar + 1}) canvas`);
  }, wideSaved.avatar);
  assert(fallback, 'mismatched custom avatar should draw the chosen default');
  await page.getByRole('button', { name: 'Enter the office' }).click();
  await page.getByRole('button', { name: 'Edit profile', exact: true }).waitFor();
  await page.waitForFunction(() => document.querySelector('canvas[data-testid="game-canvas"]').dataset.avatarColumn === '-1');
  assert.deepEqual(errors, []);
  console.log('Agent MCP upload, custom rendering, selector isolation, profile edits, cookies, reload, default reselection, a 3-walk 5-dance sheet walking and dancing in the office, and a mismatched sheet falling back passed.');
} finally { await browser.close(); }
