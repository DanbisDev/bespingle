import { chromium } from 'playwright';
import assert from 'node:assert/strict';

const browser = await chromium.launch({
  executablePath: process.env.CHROME_PATH || undefined,
  headless: true,
  args: ['--no-sandbox', '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'],
});
try {
  const context = await browser.newContext({ permissions: ['microphone', 'camera'] });
  await context.addInitScript(() => {
    window.__captures = [];
    const capture = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
    navigator.mediaDevices.getUserMedia = async (constraints) => {
      const stream = await capture(constraints);
      window.__captures.push({ constraints, stream });
      return stream;
    };
  });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto('http://localhost:5555');
  await page.getByLabel('Your display name').fill('Audio check');
  await page.getByRole('button', { name: 'Enter the office', exact: true }).click();
  const settings = () => page.getByRole('button', { name: 'Audio and video settings', exact: true }).click();
  const done = () => page.getByRole('button', { name: 'Done', exact: false }).click();
  const toggle = () => page.getByRole('checkbox', { name: 'Noise suppression', exact: true });
  await settings();
  assert(await toggle().isChecked(), 'Suppression defaults on');
  await toggle().uncheck();
  await done();
  assert.equal(await page.evaluate(() => window.__captures.length), 0, 'Settings do not open the microphone');
  await page.getByRole('button', { name: 'Turn microphone on', exact: true }).click();
  await page.getByRole('button', { name: 'Turn microphone off', exact: true }).waitFor();
  const state = () => page.evaluate(() => window.__captures.map(({ constraints, stream }) => ({
    constraints, tracks: stream.getTracks().map((track) => ({ id: track.id, state: track.readyState, settings: track.getSettings() })),
  })));
  const initial = await state();
  assert.equal(initial[0].constraints.audio.noiseSuppression, false);
  assert.equal(initial[0].tracks[0].settings.noiseSuppression, false);
  assert.equal(initial[0].tracks[0].settings.echoCancellation, true);
  await settings();
  await toggle().click();
  await page.waitForFunction(() => !document.querySelector('.noise-setting input').disabled);
  assert(await toggle().isChecked());
  const active = await state();
  assert.equal(active.length, 1, 'Live switching does not recapture');
  assert.equal(active[0].tracks[0].id, initial[0].tracks[0].id);
  if (active[0].tracks[0].settings.noiseSuppression) {
    await page.getByText('Noise suppression is active.', { exact: true }).waitFor();
  } else {
    await page.getByText('Turn your microphone off and on', { exact: false }).waitFor();
  }
  assert.equal(active[0].tracks[0].settings.echoCancellation, true);
  assert.equal(active[0].tracks[0].settings.autoGainControl, true);
  // A failed setting change preserves capture and the previous preference.
  await page.evaluate(() => {
    window.__captures[0].stream.getAudioTracks()[0].applyConstraints = async () => { throw new Error('Device busy'); };
  });
  await toggle().click();
  await page.getByRole('alert').filter({ hasText: 'Could not change noise suppression.' }).waitFor();
  assert(await toggle().isChecked());
  assert.equal((await state())[0].tracks[0].state, 'live');
  await done();
  await page.getByRole('button', { name: 'Turn microphone off', exact: true }).click();
  await page.getByRole('button', { name: 'Turn microphone on', exact: true }).click();
  await page.getByRole('button', { name: 'Turn microphone off', exact: true }).waitFor();
  assert.equal((await state())[1].constraints.audio.noiseSuppression, true, 'Re-enabled mic keeps the choice');
  assert.equal((await state())[1].tracks[0].settings.noiseSuppression, true, 'Recapture applies suppression in browsers that cannot switch live');
  await page.getByRole('button', { name: 'Leave office', exact: true }).click();
  await page.waitForFunction(() => window.__captures.every(({ stream }) => stream.getTracks().every((track) => track.readyState === 'ended')));
  // Unsupported browsers remain usable and do not claim suppression is active.
  await page.addInitScript(() => { navigator.mediaDevices.getSupportedConstraints = () => ({}); });
  await page.reload();
  await page.getByLabel('Your display name').fill('Unsupported audio');
  await page.getByRole('button', { name: 'Enter the office', exact: true }).click();
  await settings();
  assert(await toggle().isDisabled());
  await page.getByText('Noise suppression is unavailable in this browser.', { exact: true }).waitFor();
  assert.deepEqual(errors, []);
  console.log('PASS: real browser audio settings, live switching, track reuse, failure recovery, mute/re-enable, cleanup, and unsupported browsers');
} finally {
  await browser.close();
}
