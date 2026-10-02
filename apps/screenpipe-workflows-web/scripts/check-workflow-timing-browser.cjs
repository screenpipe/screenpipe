// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com
// Test the real desktop browser preview. Optionally use the native test's saved catalog.
const { chromium } = require('playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const catalogPath = process.env.WORKFLOW_TIMING_CATALOG_OUTPUT;
const catalog = catalogPath ? JSON.parse(fs.readFileSync(catalogPath, 'utf8')) : null;
const title = catalog?.analysis.workflows[0].title || 'Research synthesis';
const average = catalog ? '7m' : '24m';
const stepTime = catalog ? '4m for one run' : '5m on average';
const output = process.env.WORKFLOW_TIMING_ARTIFACTS || '/tmp/workflow-timing-hover';
fs.mkdirSync(output, { recursive: true });
(async () => {
  const browser = await chromium.launch({ headless: true, channel: "chrome" });
  let page;
  try {
    page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    const base = process.env.WORKFLOW_TIMING_PREVIEW_URL || 'http://127.0.0.1:1420/home?mode=workflows';
    if (catalog) await page.addInitScript(value => { const key = 'screenpipe:fictional-workflow-editor-preview'; if (!localStorage.getItem(key)) localStorage.setItem(key, JSON.stringify(value)); }, catalog);
    await page.goto(base);
    await page.getByRole('heading', { name: title, exact: true, includeHidden: true }).waitFor({ state: 'attached' });
    // The mock desktop can show the unrelated storage migration prompt on first launch.
    const later = page.getByRole('button', { name: 'Do later', exact: true });
    try { await later.waitFor({ timeout: 5000 }); await later.click(); }
    catch (error) { if (error.name !== 'TimeoutError') throw error; }
    const card = page.getByRole('heading', { name: title, exact: true }).locator('..');
    await card.waitFor();
    assert.equal(await page.getByRole('tooltip').count(), 0);
    await page.screenshot({ path: path.join(output, 'catalog.png') });
    const cardClock = card.getByRole('button', { name: `Timing for ${title}`, exact: true });
    await cardClock.hover();
    await page.getByRole('tooltip').getByText(`${average} on average`, { exact: true }).waitFor();
    await card.screenshot({ path: path.join(output, 'card-hover.png') });
    await cardClock.focus();
    await page.keyboard.press('Escape');
    assert.equal(await page.getByRole('tooltip').count(), 0);
    await card.getByRole('button', { name: 'Open map' }).click();
    const titleInput = page.getByRole('textbox', { name: 'Workflow title', exact: true });
    await titleInput.waitFor();
    const global = page.getByRole('button', { name: 'Workflow timing', exact: true });
    await global.hover();
    await page.getByRole('tooltip').getByText(`${average} on average`, { exact: true }).waitFor();
    await page.screenshot({ path: path.join(output, 'workflow-hover.png') });
    await titleInput.hover();
    const first = page.getByRole('button', { name: 'Timing for step 1', exact: true });
    await first.hover();
    await page.getByRole('tooltip').getByText(stepTime, { exact: true }).waitFor();
    await page.screenshot({ path: path.join(output, 'step-hover.png') });
    await first.focus();
    await page.keyboard.press('Escape');
    assert.equal(await page.getByRole('tooltip').count(), 0);
    const unknown = page.getByRole('button', { name: 'Timing for step 2', exact: true });
    await unknown.click();
    await page.getByRole('tooltip').getByText('Time not measured yet', { exact: true }).waitFor();
    await titleInput.click();
    assert.equal(await page.getByRole('tooltip').count(), 0);
    // Keyboard reorder must keep the sampled timing with the step's source.
    await page.getByRole('button', { name: 'Move step 1', exact: true }).focus();
    await page.keyboard.press('Alt+ArrowDown');
    await page.getByRole('button', { name: 'Timing for step 2', exact: true }).hover();
    await page.getByRole('tooltip').getByText(stepTime, { exact: true }).waitFor();
    // Wait for the real fixture adapter's autosave, then reload and reopen.
    await page.getByText('Saved', { exact: true }).waitFor();
    await page.reload();
    await page.getByRole('heading', { name: title, exact: true, includeHidden: true }).waitFor({ state: 'attached' });
    try { await later.waitFor({ timeout: 5000 }); await later.click(); }
    catch (error) { if (error.name !== 'TimeoutError') throw error; }
    const reopenedCard = page.getByRole('heading', { name: title, exact: true }).locator('..');
    await reopenedCard.getByRole('button', { name: 'Open map' }).click();
    await page.getByRole('textbox', { name: 'Workflow title', exact: true }).waitFor();
    await page.getByRole('button', { name: 'Timing for step 2', exact: true }).hover();
    await page.getByRole('tooltip').getByText(stepTime, { exact: true }).waitFor();
    await page.setViewportSize({ width: 700, height: 900 });
    const clock = page.getByRole('button', { name: 'Timing for step 2', exact: true });
    await clock.click();
    const bounds = await page.getByRole('tooltip').boundingBox();
    assert(bounds && bounds.x >= 0 && bounds.x + bounds.width <= 700, 'timing disclosure fits narrow window');
    assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    await page.screenshot({ path: path.join(output, 'narrow.png') });
    assert.deepEqual(errors, []);
    console.log('PASS averages, single/unknown timing, hover, keyboard/Escape, tap/dismiss, reorder, saved reload, narrow layout, no browser errors');
  } catch (error) {
    if (page) { console.error('Browser state:', page.url(), (await page.locator('body').innerText()).slice(0,5000)); await page.screenshot({ path: path.join(output, 'failure.png') }); }
    throw error;
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
