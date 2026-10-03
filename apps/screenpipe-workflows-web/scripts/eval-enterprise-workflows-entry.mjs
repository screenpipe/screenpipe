// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com
// Run against the desktop browser-mock server with NEXT_PUBLIC_SCREENPIPE_E2E=true.
// Uses the existing enterprise E2E policy fixture. No real credentials or cloud requests.
import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';

const base = process.env.WORKFLOWS_ENTRY_URL || 'http://127.0.0.1:1420';
const out = process.env.WORKFLOWS_ENTRY_SCREENSHOTS || '/tmp/screenpipe-enterprise-workflows';
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
    assert.equal(await page.getByRole('button', { name: 'Switch workspace', exact: true }).count(), 0,
      'Unauthenticated enterprise devices must remain behind the workspace gate');
    await page.getByPlaceholder('ENT-XXXX-XXXX-XXXX-XXXX').fill('ENT-TEST-TEST-TEST-TEST');
    await page.getByRole('button', { name: 'Activate', exact: true }).click();
    await page.getByRole('button', { name: 'Do later', exact: true }).click({ timeout: 5000 }).catch(() => {});
  }
  const capture = name => page.screenshot({ path: `${out}/${name}.png`, animations: 'disabled', style: 'nextjs-portal { display: none; }' });
  await authenticate();
  await page.getByRole('button', { name: 'Switch workspace', exact: true }).waitFor();
  await capture('enterprise-home-after');
  await page.getByRole('button', { name: 'Switch workspace', exact: true }).click();
  await page.getByRole('menuitemradio', { name: /^Workflows/ }).waitFor();
  await capture('enterprise-dropdown-after');
  await page.getByRole('menuitemradio', { name: /^Workflows/ }).click();
  await page.getByRole('heading', { name: 'Research synthesis', exact: true }).waitFor();
  await capture('enterprise-workflows-after');
  await page.getByRole('button', { name: 'Switch workspace', exact: true }).click();
  await page.getByRole('menuitemradio', { name: /^Chat/ }).click();
  await page.getByRole('button', { name: 'Switch workspace', exact: true }).waitFor();
  assert.equal(await page.getByRole('heading', { name: 'Research synthesis', exact: true }).isVisible(), false);
  await authenticate('/home?mode=workflows');
  await page.getByRole('heading', { name: 'Research synthesis', exact: true }).waitFor();
  console.log('PASS: enterprise authentication gate, Home dropdown, switching to Workflows, returning to Chat, and Workflows deep link');
} catch (error) {
  if (page) {
    console.error(await page.locator('body').innerText());
    await page.screenshot({ path: `${out}/failure.png` });
  }
  throw error;
} finally {
  await browser.close();
}
