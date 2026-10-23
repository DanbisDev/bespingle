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
  assert.deepEqual(errors, []);
  console.log('Agent MCP upload, custom rendering, selector isolation, profile edits, cookies, reload and default reselection passed.');
} finally { await browser.close(); }
