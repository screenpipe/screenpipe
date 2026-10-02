// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com
const { chromium } = require('playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs');
(async () => {
  const browser = await chromium.launch({ headless: true, channel: 'chrome' });
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    const errors = []; page.on('pageerror', e => errors.push(e.message));
    await page.goto((process.env.WORKFLOWS_PREVIEW_URL || 'http://localhost:1431/preview') + '?catalog=source-preview');
    await page.getByRole('button', { name: 'Open map', exact: true }).first().click();
    await page.getByRole('button', { name: 'Create SOP', exact: true }).click();
    await page.getByRole('button', { name: 'Video SOP', exact: true }).waitFor();
    await page.getByRole('button', { name: 'Minimize chat', exact: true }).click();
    await page.getByRole('button', { name: 'Video SOP', exact: true }).click();
    const image = page.getByRole('img', { name: /^Screenshot for 1\./ });
    await image.waitFor();
    assert(await image.evaluate(img => img.complete && img.naturalWidth > 0));
    assert.equal(await page.getByText('Screenshot will load from the recording').count(), 0);
    const dir = process.env.SOURCE_PREVIEW_SCREENSHOTS || '/tmp/source-preview-eval';
    fs.mkdirSync(dir, { recursive: true });
    await page.screenshot({ path: dir + '/loaded.png' });
    assert.deepEqual(errors, []);
    console.log('PASS: timestamp-only source resolves to a visible screenshot in Video SOP before rendering');
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
