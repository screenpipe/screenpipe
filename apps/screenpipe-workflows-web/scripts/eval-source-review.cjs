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
    const dir = process.env.SOURCE_REVIEW_SCREENSHOTS || '/tmp/source-review-eval';
    fs.mkdirSync(dir, { recursive: true });
    await page.goto((process.env.WORKFLOWS_PREVIEW_URL || 'http://localhost:1431/preview') + '?catalog=stale-sop');
    await page.getByRole('button', { name: 'Open map', exact: true }).first().click();
    await page.getByRole('button', { name: 'Open SOP', exact: true }).click();
    const review = page.getByRole('region', { name: 'Review screenshot links' });
    await review.waitFor();
    assert.equal(await review.getByRole('combobox').count(), 0);
    assert((await review.boundingBox()).height < 60);
    await page.screenshot({ path: dir + '/collapsed.png' });
    await review.getByRole('button', { name: 'Review screenshots' }).click();
    const first = review.getByRole('combobox').first();
    await first.selectOption('none');
    await review.getByRole('button', { name: 'Close review' }).click();
    assert.equal(await review.getByRole('combobox').count(), 0);
    await review.getByRole('button', { name: 'Review screenshots' }).click();
    assert.equal(await first.inputValue(), 'none');
    await first.selectOption('0');
    await page.screenshot({ path: dir + '/expanded.png' });
    await page.setViewportSize({ width: 900, height: 800 });
    assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    await page.screenshot({ path: dir + '/compact.png' });
    await review.getByRole('button', { name: 'Save screenshot choices' }).click();
    await review.waitFor({ state: 'detached' });
    assert.deepEqual(errors, []);
    console.log('PASS: collapsed review, open/close preserves unsaved choices, compact layout, save resolves stale links, no page errors');
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
