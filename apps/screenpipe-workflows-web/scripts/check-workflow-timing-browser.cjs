// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com
// Consume the catalog saved by workflow_timing_e2e. No user data or live app writes.
const { chromium } = require('playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const catalogPath = process.env.WORKFLOW_TIMING_CATALOG_OUTPUT;
if (!catalogPath) throw new Error('Set WORKFLOW_TIMING_CATALOG_OUTPUT to the native test catalog');
const catalog = JSON.parse(fs.readFileSync(catalogPath, 'utf8'));
const workflow = catalog.analysis.workflows[0];
(async () => {
  const browser = await chromium.launch({ headless: true, channel: 'chrome' });
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    const base = process.env.WORKFLOW_TIMING_PREVIEW_URL || 'http://127.0.0.1:1437/preview.html';
    await page.goto(base + '?catalog=empty');
    await page.evaluate(value => localStorage.setItem('screenpipe:fictional-workflow-editor-preview', JSON.stringify(value)), catalog);
    await page.goto(base + '?catalog=native-timing');
    await page.getByRole('heading', { name: workflow.title, exact: true }).waitFor();
    await page.getByText(/~7m \/ run · estimated/).waitFor();
    await page.getByText('Workflow details', { exact: true }).click();
    await page.getByText('~7m', { exact: true }).waitFor();
    assert.equal(await page.getByText('2 runs · estimated', { exact: true }).count(), 1);
    await page.locator('article').first().screenshot({ path: process.env.WORKFLOW_TIMING_CARD_SCREENSHOT || '/tmp/workflow-timing-native-card.png' });
    await page.getByRole('button', { name: 'Open map' }).click();
    await page.getByText('Evidence and limitations', { exact: true }).click();
    const region = page.getByRole('region', { name: 'Time per run' });
    await region.waitFor();
    assert.match(await region.innerText(), /6m–8m across 2 runs/);
    assert.equal(await region.locator('summary').count(), 2);
    await region.locator('summary').first().click();
    await region.getByText(workflow.timing.runs[0].start.quote, { exact: true }).waitFor();
    await region.getByText(workflow.timing.runs[0].end.quote, { exact: true }).waitFor();
    await page.screenshot({ path: process.env.WORKFLOW_TIMING_SCREENSHOT || '/tmp/workflow-timing-native-ui.png', fullPage: true });
    await page.setViewportSize({ width: 700, height: 900 });
    assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    await page.goto(base + '?catalog=native-timing');
    await page.getByText(/~7m \/ run · estimated/).waitFor();
    await page.reload();
    await page.getByText(/~7m \/ run · estimated/).waitFor();
    assert.deepEqual(errors, []);
    console.log('PASS native saved catalog: 7m average, two distinct runs, evidence disclosure, narrow layout, reload, no browser errors');
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
