// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com
const { chromium } = require("playwright");
const assert = require("node:assert/strict");
(async () => {
  const browser = await chromium.launch({ headless: true, channel: "chrome" });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  page.setDefaultTimeout(10000);
  const errors = [];
  page.on("pageerror", e => errors.push(e.message));
  try {
    await page.goto(process.env.WORKFLOWS_PREVIEW_URL || "http://127.0.0.1:1431/preview");
    const card = page.locator("article").filter({ has: page.getByRole("heading", { name: "Research synthesis", exact: true }) });
    await card.getByText("Workflow details", { exact: true }).click();
    assert(await card.getByText("A research question is defined", { exact: true }).isVisible());
    await card.getByRole("button", { name: "Open map" }).click();
    const field = page.getByRole("textbox", { name: "Block 1 in step 1", exact: true });
    assert.equal(await field.getAttribute("contenteditable"), "true");
    await field.fill("");
    await field.evaluate(el => {
      const clipboardData = new DataTransfer();
      clipboardData.setData("text/plain", "**Review the sources**\n\n1. Check the `order_id`.\n2. Read [the guide](https://example.com/guide).\n\n![Evidence](snapshot:42)");
      el.dispatchEvent(new ClipboardEvent("paste", { bubbles: true, cancelable: true, clipboardData }));
    });
    await field.locator("strong").waitFor();
    assert.equal(await field.locator("li").count(), 2);
    assert.equal(await field.locator("img[src]").count(), 0);
    assert.equal(await field.locator("a").getAttribute("rel"), "noopener noreferrer");
    await page.getByRole("status", { name: "Save status" }).filter({ hasText: /^Saved$/ }).waitFor();
    await page.reload();
    await page.getByRole("button", { name: "Open map", exact: true }).first().click();
    await field.locator("strong").waitFor();
    assert.equal(await field.locator("strong").innerText(), "Review the sources");
    console.log("PASS pasted Markdown renders inline, autosaves, and survives reload; images stay references");
    const originalDocument = await field.innerHTML();
    await field.fill("");
    await field.pressSequentially("**Confirmed**");
    assert.equal(await field.locator("strong").last().innerText(), "Confirmed");
    await field.press("ControlOrMeta+z");
    assert.equal(await field.innerHTML(), originalDocument);
    await field.press("ControlOrMeta+Shift+z");
    assert.equal(await field.locator("strong").last().innerText(), "Confirmed");
    console.log("PASS Markdown input rules and keyboard undo/redo preserve formatting");
    await page.setViewportSize({ width: 430, height: 932 });
    await page.getByRole("button", { name: "Open left sidebar", exact: true }).waitFor();
    await page.getByRole("button", { name: "All workflows", exact: true }).click();
    await page.getByRole("button", { name: "Open left sidebar", exact: true }).click();
    await page.getByRole("navigation", { name: "Primary navigation" }).getByRole("button", { name: /^Home/ }).click();
    await page.getByRole("button", { name: "Open left sidebar", exact: true }).waitFor();
    assert.equal(await page.getByRole("complementary", { name: "Navigation sidebar" }).isVisible(), false);
    console.log("PASS compact navigation closes on resize and after choosing a page");
    assert.deepEqual(errors, []);
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
