// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com
const { chromium } = require("playwright");
const assert = require("node:assert/strict"),
  fs = require("fs");
(async () => {
  const b = await chromium.launch({ headless: true, channel: "chrome" });
  const p = await b.newPage({ viewport: { width: 1440, height: 1000 } });
  p.setDefaultTimeout(12000);
  const errors = [];
  p.on("pageerror", (e) => errors.push(e.message));
  const dir = process.env.SOP_SCREENSHOTS || "/tmp/sop-chat-eval";
  fs.mkdirSync(dir, { recursive: true });
  await p.goto(
    process.env.WORKFLOWS_PREVIEW_URL || "http://localhost:1431/preview",
  );
  await p.getByRole("button", { name: "Open map" }).first().click();
  await p.screenshot({ path: dir + "/desktop-workflow.png" });
  await p.getByRole("button", { name: "Create SOP", exact: true }).click();
  await p.getByRole("button", { name: "Stop answer", exact: true }).waitFor();
  await p.screenshot({ path: dir + "/desktop-creating.png" });
  await p
    .getByText("Saved your SOP on this device. Review its steps on the page.", {
      exact: true,
    })
    .waitFor({ timeout: 15000 });
  await p.screenshot({ path: dir + "/desktop-saved.png" });
  await p.getByRole("button", { name: "Minimize chat", exact: true }).click();
  await p.screenshot({ path: dir + "/desktop-document.png" });
  assert.equal(
    await p.locator('article[aria-label="SOP document"] h1').innerText(),
    "Research synthesis",
  );
  await p.reload();
  await p.getByRole("button", { name: "Open map" }).first().click();
  await p.getByRole("button", { name: "Create SOP", exact: true }).click();
  await p.getByText("Before you start", { exact: true }).last().waitFor();
  assert.equal(
    await p.getByRole("button", { name: "Stop answer", exact: true }).count(),
    0,
  );
  await p.setViewportSize({ width: 390, height: 844 });
  await p.screenshot({ path: dir + "/desktop-mobile.png" });
  assert(
    await p.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
  );
  assert.deepEqual(errors, []);
  console.log(
    "PASS create in chat, real adapter persistence receipt, reopen without generation, mobile overflow; fixture adapter only",
  );
  await b.close();
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
