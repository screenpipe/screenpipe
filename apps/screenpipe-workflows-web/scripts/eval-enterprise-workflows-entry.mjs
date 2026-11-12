// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com
// Run against the desktop browser-mock server with NEXT_PUBLIC_SCREENPIPE_E2E=true.
// Uses the existing enterprise E2E policy fixture. No real credentials or cloud requests.
import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';

const base = process.env.CLOUD_WORKFLOWS_URL || 'http://127.0.0.1:1420';
const out = process.env.CLOUD_WORKFLOWS_SCREENSHOTS || '/tmp/screenpipe-enterprise-workflows';
mkdirSync(out, { recursive: true });
let page;
const browser = await chromium.launch({ headless: true, channel: process.env.PLAYWRIGHT_CHANNEL || 'chrome' });
try {
  page = await browser.newPage({ viewport: { width: 1440, height: 960 } });
  page.on('pageerror', error => console.error(error.stack));
  page.setDefaultTimeout(30_000);
  await page.addInitScript(() => {
    localStorage.setItem('screenpipe_e2e_force_enterprise_build', '1');
    localStorage.setItem('screenpipe_e2e_enterprise_policy', JSON.stringify({
      policy: { orgName: 'Example workspace' },
    }));
    localStorage.setItem('screenpipe_e2e_enterprise_heartbeat_status', '200');
  });
  async function authenticate(path = '/home') {
    await page.goto(base + path, { waitUntil: 'domcontentloaded', timeout: 120_000 });
    await page.getByRole('button', { name: 'Use enterprise key', exact: true }).click();
    assert.equal(await page.getByRole('group', { name: 'Switch workspace', exact: true }).count(), 0,
      'Unauthenticated enterprise devices must remain behind the workspace gate');
    await page.getByPlaceholder('ENT-XXXX-XXXX-XXXX-XXXX').fill('ENT-TEST-TEST-TEST-TEST');
    await page.getByRole('button', { name: 'Activate', exact: true }).click();
    await page.getByRole('button', { name: 'Do later', exact: true }).click({ timeout: 5000 }).catch(() => {});
  }
  const capture = name => page.screenshot({ path: `${out}/${name}.png`, animations: 'disabled', style: 'nextjs-portal { display: none; }' });
  await authenticate();
  await page.getByRole('group', { name: 'Switch workspace', exact: true }).waitFor();
  await capture('enterprise-home-after');
  await page.getByRole('group', {name: 'Switch workspace', exact: true}).getByRole('button', {name: 'Workflows', exact: true}).click();
  await page.getByRole('button', { name: 'Keep local processing', exact: true }).click();
  await page.getByRole('dialog', { name: 'Turn off local workflow processing?' }).waitFor({ state: 'hidden' });
  assert.equal(await page.getByRole('combobox', { name: 'Workflow source' }).inputValue(), 'cloud',
    'Enterprise entry must default to the cloud catalog without a query-string source override');
  await page.getByRole('heading', { name: 'Workflows', exact: true }).waitFor();
  await capture('enterprise-cloud-after');
  await page.locator('article').filter({ has: page.getByRole('heading', { name: 'Research synthesis', exact: true }) }).getByRole('button').click();
  await page.getByRole('heading', { name: 'Collect sources', exact: true }).waitFor();
  await page.getByRole('group', {name: 'Switch workspace', exact: true}).getByRole('button', {name: 'Memory', exact: true}).click();
  await page.getByRole('group', { name: 'Switch workspace', exact: true }).waitFor();
  assert.equal(await page.getByRole('heading', { name: 'Collect sources', exact: true }).isVisible(), false);
  // The denied-cloud scenario starts from an unauthenticated device. A reload
  // now correctly retains the earlier mock activation, just as native does.
  await page.evaluate(() => window.__TAURI_INTERNALS__.invoke('save_enterprise_license_key', { licenseKey: '' }));
  await authenticate('/home?mode=workflows&cloudWorkflowState=error');
  await page.getByRole('button', { name: 'Keep local processing', exact: true }).click();
  await page.getByRole('heading', { name: 'Cloud workflows unavailable', exact: true }).waitFor();
  assert.equal(await page.locator('article').count(), 0, 'Cloud denial must not expose cached workflows');
  console.log('PASS: enterprise authentication gate, Home switcher, default cloud source, workflow steps, return to Memory, and denied cloud deep link');
} catch (error) {
  if (page) {
    console.error(await page.locator('body').innerText());
    await page.screenshot({ path: `${out}/failure.png` });
  }
  throw error;
} finally {
  await browser.close();
}
