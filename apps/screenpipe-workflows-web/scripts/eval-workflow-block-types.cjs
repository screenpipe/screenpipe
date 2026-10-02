// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com
const { chromium } = require("playwright");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const out = process.env.WORKFLOW_EDITOR_ARTIFACTS || path.join(require("node:os").tmpdir(), "screenpipe-block-types");
fs.mkdirSync(out, { recursive: true });
(async () => {
  const browser = await chromium.launch({ headless: true, channel: "chrome" });
  const url = process.env.WORKFLOWS_PREVIEW_URL || "http://127.0.0.1:1431/preview";
  const key = "screenpipe:fictional-workflow-editor-preview";
  const errors = [];
  try {
    for (const touch of [false, true]) {
      const context = await browser.newContext({ viewport: { width: touch ? 390 : 1440, height: 1000 }, hasTouch: touch, isMobile: touch });
      const page = await context.newPage();
      page.setDefaultTimeout(10000);
      page.on("pageerror", e => errors.push(e.message));
      const open = async () => {
        await page.getByRole("button", { name: "Open map", exact: true }).first().click();
        await page.getByRole("textbox", { name: "Workflow title", exact: true }).waitFor();
      };
      const stored = () => page.evaluate(key => JSON.parse(localStorage.getItem(key)).analysis.workflows.find(w => w.id === "Research synthesis"), key);
      const saved = () => page.getByRole("status", { name: "Save status" }).filter({ hasText: /^Saved$/ }).waitFor();
      await page.goto(url); await open();
      const type = page.getByRole("combobox", { name: "Block 1 type in step 1", exact: true });
      const text = page.getByRole("textbox", { name: "Block 1 in step 1", exact: true });
      const originalText = await text.innerText();
      await type.focus();
      assert(await type.evaluate(el => document.activeElement === el));
      let baseline;
      for (const kind of ["input", "output", "decision", "check", "action"]) {
        await type.selectOption(kind); await saved();
        const workflow = await stored();
        assert.equal(workflow.stages[0].procedure[0].kind, kind);
        assert.equal(await text.innerText(), originalText);
        baseline ??= workflow;
        assert.deepEqual(workflow.stages[0].screenshot, baseline.stages[0].screenshot);
        assert.equal(await page.getByRole("dialog").count(), 0);
      }
      await type.selectOption("output"); await saved();
      await type.focus();
      await page.keyboard.press("i"); await page.keyboard.press("Enter"); await saved();
      assert.equal(await type.inputValue(), "input");
      await page.getByRole("button", { name: "Undo last edit", exact: true }).click(); await saved();
      assert.equal(await type.inputValue(), "output");
      await type.selectOption("decision"); await saved();
      await type.focus();
      await page.screenshot({ path: path.join(out, touch ? "after-touch.png" : "after-desktop.png") });
      const beforeReload = await stored();
      await page.reload(); await open();
      assert.equal(await type.inputValue(), "decision");
      assert.deepEqual(await stored(), beforeReload);
      if (touch) assert(await type.evaluate(el => el.getBoundingClientRect().right <= innerWidth));
      const grip = page.getByRole("button", { name: "Move block 1 in step 1", exact: true });
      await text.focus(); await grip.click();
      await page.getByRole("button", { name: "Delete block 1 in step 1", exact: true }).waitFor();
      await page.keyboard.press("Escape");
      assert(await grip.evaluate(el => document.activeElement === el));
      await grip.press("Alt+ArrowDown"); await saved();
      assert.equal((await stored()).stages[0].procedure[1].kind, "decision");
      console.log(`PASS ${touch ? "touch / narrow" : "desktop"}: all five types, keyboard, autosave, undo, reload, preserved text/screenshots, menu dismissal, reorder`);
      await context.close();
    }
    assert.deepEqual(errors, []);
    console.log("PASS no browser exceptions");
  } finally { await browser.close(); }
})().catch(e => { console.error(e); process.exitCode = 1; });
