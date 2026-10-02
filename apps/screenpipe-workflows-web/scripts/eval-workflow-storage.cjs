// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com
const { chromium } = require("playwright");
const assert = require("node:assert/strict");

// Uses the maintained fictional preview. Never opens or edits a live catalog.
(async () => {
  const browser = await chromium.launch({ headless: true, channel: "chrome" });
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 1080 } });
    page.setDefaultTimeout(20000);
    const errors = [];
    page.on("pageerror", error => errors.push(error.message));
    const base = process.env.WORKFLOWS_PREVIEW_URL || "http://127.0.0.1:1431/preview";
    const field = name => page.getByRole("textbox", { name, exact: true });
    const button = name => page.getByRole("button", { name, exact: true });

    await page.goto(base);
    await button("Open map").first().click();
    await field("Workflow title").fill("Review synthesis safely");
    await field("Workflow description").click();
    await page.getByRole("status", { name: "Save status" }).filter({ hasText: /^Saved$/ }).waitFor();
    await page.reload();
    await button("Open map").first().click();
    assert.equal(await field("Workflow title").textContent(), "Review synthesis safely");
    await button("Context").click();
    await field("Role and responsibilities").waitFor();
    await page.getByRole("button", { name: /^Home/ }).click();
    await page.getByRole("heading", { name: "Your workflows", exact: true }).waitFor();

    for (const view of ["overview", "time", "bottlenecks", "evidence", "privacy"]) {
      const url = new URL(base);
      url.searchParams.set("view", view);
      await page.goto(url.toString());
      await page.getByRole("heading", { name: "Your workflows", exact: true }).waitFor();
    }
    assert.deepEqual(errors, []);
    console.log("PASS: Home, editor, saved edit after reload, Context, five obsolete routes, no page errors.");
  } finally {
    await browser.close();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
