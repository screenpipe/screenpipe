// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com
// Uses the main app's browser-mock mode, with fictional data only.
const { chromium } = require("playwright");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const base = process.env.SOP_APP_URL || "http://127.0.0.1:1457";
const out = process.env.SOP_SCREENSHOTS || "/tmp/sop-inline-editor";
fs.mkdirSync(out, { recursive: true });
(async () => {
  const browser = await chromium.launch({ headless: true, channel: "chrome" });
  try {
    const page = await browser.newPage({
      viewport: { width: 1440, height: 1000 },
    });
    page.setDefaultTimeout(20000);
    const errors = [];
    page.on("pageerror", (e) => {
      errors.push(e.message);
      console.error("Browser error:", e.stack);
    });
    async function dismiss() {
      await page
        .getByRole("button", { name: "Do later", exact: true })
        .click({ timeout: 5000 })
        .catch(() => {});
      await page
        .getByRole("alertdialog")
        .waitFor({ state: "hidden", timeout: 5000 })
        .catch(() => {});
    }
    async function snap(name) {
      console.log("capture", name);
      await page.screenshot({
        path: `${out}/${name}.png`,
        animations: "disabled",
      });
    }
    async function open() {
      await page.goto(base + "/home?mode=workflows");
      await page.getByText("Research synthesis", { exact: true }).waitFor();
      await dismiss();
      await page
        .getByRole("button", { name: "Open map", exact: true })
        .first()
        .click();
      await page
        .getByRole("button", { name: "Create SOP", exact: true })
        .click();
      await page
        .getByRole("textbox", { name: "SOP title", exact: true })
        .waitFor()
        .catch(async (error) => {
          console.log((await page.locator("body").innerText()).slice(-5000));
          throw error;
        });
      const minimize = page.getByRole("button", {
        name: "Minimize chat",
        exact: true,
      });
      if (await minimize.isVisible()) await minimize.click();
    }
    await open();
    assert.equal(
      await page
        .getByRole("button", { name: "Open web editor", exact: true })
        .innerText(),
      "Open on web",
    );
    assert.equal(
      await page
        .getByRole("button", { name: "Export SOP", exact: true })
        .innerText(),
      "Export",
    );
    const title = page.getByRole("textbox", { name: "SOP title", exact: true });
    assert.equal(
      await page.getByRole("button", { name: "Edit SOP", exact: true }).count(),
      0,
    );
    await page.mouse.move(900, 200);
    await snap("after-idle");
    const grip = page.getByRole("button", {
      name: "Reorder step 1",
      exact: true,
    });
    assert.equal(
      await grip.evaluate((el) => getComputedStyle(el).opacity),
      "0",
    );
    await page.locator("#guide-step-0").scrollIntoViewIfNeeded();
    await page.getByLabel("Step 1 title", { exact: true }).hover();
    await page.waitForTimeout(200);
    assert.equal(
      await grip.evaluate((el) => getComputedStyle(el).opacity),
      "1",
    );
    await snap("after-hover");
    await page.getByLabel("Step 1 actions", { exact: true }).click();
    await snap("after-menu");
    await page
      .getByRole("button", { name: "Move step 1 down", exact: true })
      .click();
    assert.equal(
      await page.locator("details[data-step-actions][open]").count(),
      0,
    );
    await page
      .getByRole("button", { name: "Reorder step 2", exact: true })
      .focus();
    await page.keyboard.press("Alt+ArrowUp");
    await grip.focus();
    await page.keyboard.press("Alt+ArrowDown");
    assert.equal(
      await page.getByLabel("Step 2 title", { exact: true }).inputValue(),
      "Collect sources",
    );
    await page.keyboard.press("Alt+ArrowUp");
    assert.equal(
      await page.getByLabel("Step 1 title", { exact: true }).inputValue(),
      "Collect sources",
    );
    // Real HTML drag/drop into the instruction editor must reorder the whole step.
    await page.getByLabel("Step 1 title", { exact: true }).hover();
    await grip.scrollIntoViewIfNeeded();
    await grip.focus();
    assert.equal(
      await grip.evaluate((el) => getComputedStyle(el).webkitUserDrag),
      "element",
    );
    const sourceBox = await grip.boundingBox();
    await page.mouse.move(
      sourceBox.x + sourceBox.width / 2,
      sourceBox.y + sourceBox.height / 2,
    );
    await page.mouse.down();
    await page.mouse.move(sourceBox.x + 40, sourceBox.y + 10, { steps: 10 });
    await page
      .getByLabel("Step 2 instructions", { exact: true })
      .scrollIntoViewIfNeeded();
    const targetBox = await page
      .getByLabel("Step 2 instructions", { exact: true })
      .boundingBox();
    await page.mouse.move(targetBox.x + 30, targetBox.y + 15, { steps: 15 });
    await page.mouse.move(targetBox.x + 35, targetBox.y + 15, { steps: 2 });
    await page.mouse.up();
    assert.equal(
      await page.getByLabel("Step 2 title", { exact: true }).inputValue(),
      "Collect sources",
    );
    await page
      .getByRole("button", { name: "Reorder step 2", exact: true })
      .focus();
    await page.keyboard.press("Alt+ArrowUp");
    await title.fill(
      "Research synthesis: a repeatable guide for reviewing evidence and sharing findings",
    );
    await snap("after-editing");
    const summary = page.getByLabel("Guide summary", { exact: true });
    await summary.fill(
      "Collect evidence, compare findings, and share a clear brief.",
    );
    await page
      .getByLabel("Step 1 instructions", { exact: true })
      .fill("Keep the original sources and their references.");
    await page
      .getByLabel("Step 1 expected result", { exact: true })
      .fill("Sources ready to review.");
    await page
      .getByLabel("Before you start", { exact: true })
      .fill("A clear research question\nAccess to source documents");
    await page.getByRole("button", { name: "Add step", exact: true }).click();
    await page
      .getByLabel("Step 4 title", { exact: true })
      .fill("Share the brief");
    await page.getByLabel("Step 4 actions", { exact: true }).click();
    await page
      .getByRole("button", { name: "Remove step 4", exact: true })
      .click();
    await open();
    assert.equal(
      await title.inputValue(),
      "Research synthesis: a repeatable guide for reviewing evidence and sharing findings",
    );
    assert.equal(
      await summary.inputValue(),
      "Collect evidence, compare findings, and share a clear brief.",
    );
    assert.match(
      await page.getByLabel("Step 1 instructions", { exact: true }).innerText(),
      /Keep the original sources/,
    );
    assert.equal(
      await page
        .getByLabel("Step 1 expected result", { exact: true })
        .inputValue(),
      "Sources ready to review.",
    );
    const before = await title.boundingBox();
    await page
      .getByRole("button", { name: "Open web editor", exact: true })
      .click();
    await page.getByRole("dialog", { name: "Open SOP on the web" }).waitFor();
    assert.deepEqual(
      await title.boundingBox(),
      before,
      "Sharing does not move the document",
    );
    await snap("after-share");
    await page
      .getByRole("button", { name: "Continue to web editor", exact: true })
      .click();
    await page
      .getByRole("alert")
      .filter({ hasText: "fictional preview does not publish" })
      .waitFor();
    await snap("after-share-error");
    await page.keyboard.press("Escape");
    await page.getByRole("button", { name: "Export SOP", exact: true }).click();
    await snap("after-export");
    const download = page.waitForEvent("download");
    await page
      .getByRole("button", { name: "Export HTML", exact: true })
      .click();
    assert.match((await download).suggestedFilename(), /\.html$/);
    await title.focus();
    await snap("after-focus");
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.evaluate(() => document.documentElement.classList.add("dark"));
    await page.mouse.move(900, 200);
    await title.blur();
    await snap("after-system-dark");
    await page.evaluate(() =>
      document.documentElement.classList.remove("dark"),
    );
    for (const width of [800, 390]) {
      await page.setViewportSize({ width, height: 900 });
      await title.scrollIntoViewIfNeeded();
      await page.waitForTimeout(250);
      await snap(`after-${width}`);
      assert(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
      );
      assert(
        await title.evaluate((el) => el.scrollHeight <= el.clientHeight + 2),
        "Title wraps without clipping",
      );
    }
    await page.getByLabel("Step 1 title", { exact: true }).hover();
    const narrowGrip = await grip.boundingBox();
    assert(narrowGrip.x >= 0, "Drag handle stays inside a narrow window");
    await page.getByLabel("Step 1 actions", { exact: true }).click();
    await snap("after-narrow-controls");
    await page.keyboard.press("Escape");
    // Regression: the main workflow editor shares the inline field and drag styles.
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page
      .getByRole("button", { name: "Back to workflow", exact: true })
      .click();
    const workflowTitle = page.getByRole("textbox", {
      name: "Workflow title",
      exact: true,
    });
    await page.mouse.move(900, 150);
    await snap("workflow-toolbar");
    assert.equal(
      await page
        .getByRole("button", { name: "Create SOP", exact: true })
        .innerText(),
      "Create SOP",
    );
    await workflowTitle.fill("Research synthesis updated");
    await page
      .getByRole("status", { name: "Save status", exact: true })
      .filter({ hasText: /^Saved$/ })
      .waitFor();
    const workflowGrip = page.getByRole("button", {
      name: "Move step 1",
      exact: true,
    });
    assert.equal(
      await workflowGrip.evaluate((el) => getComputedStyle(el).webkitUserDrag),
      "element",
    );
    await workflowGrip.focus();
    await page.keyboard.press("Alt+ArrowDown");
    assert.equal(
      await page.getByLabel("Step 2 title", { exact: true }).inputValue(),
      "Collect sources",
    );
    await page.keyboard.press("Alt+ArrowUp");
    assert.equal(
      await page.getByLabel("Step 1 title", { exact: true }).inputValue(),
      "Collect sources",
    );
    assert.deepEqual(errors, []);
    console.log(
      "PASS main app SOP: inline editing, keyboard + drag reordering, add/delete, reload persistence, sharing confirmation/error, export, hover/focus/system-dark/800px/390px",
    );
  } finally {
    await browser.close();
  }
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
