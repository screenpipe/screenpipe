// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com
const { chromium } = require("playwright");
const assert = require("node:assert/strict");
const fs = require("node:fs");
(async () => {
  const browser = await chromium.launch({ headless: true, channel: "chrome" });
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    page.setDefaultTimeout(20000);
    const errors = []; page.on("pageerror", e => errors.push(e.message));
    const dir = process.env.VIDEO_CHAT_SCREENSHOTS || "/tmp/video-chat-eval";
    const before = process.env.VIDEO_CHAT_BEFORE === "1";
    fs.mkdirSync(dir, { recursive: true });
    await page.goto((process.env.WORKFLOWS_PREVIEW_URL || "http://localhost:1431/preview") + "?catalog=video-chat");
    await page.getByRole("button", { name: "Open map" }).first().click();
    await page.getByRole("button", { name: "Create SOP", exact: true }).click();
    await page.getByText("Saved your SOP on this device. Review its steps on the page.", { exact: true }).waitFor();
    await page.getByRole("button", { name: "Minimize chat", exact: true }).click();
    if (!before) {
      const intro = page.getByRole("region", { name: "Guide summary block", exact: true });
      console.log("Checking block controls");
      await intro.hover();
      await page.getByRole("button", { name: "Add block after Guide summary", exact: true }).click();
      await page.getByRole("button", { name: "Heading", exact: true }).click();
      console.log("Heading inserted");
      await page.getByRole("textbox", { name: "Heading block", exact: true }).fill("Team notes");
      await page.getByRole("button", { name: "Move heading block", exact: true }).focus();
      await page.keyboard.press("Alt+ArrowUp");
      assert(await page.locator('[data-block-id]').first().getAttribute('data-block-id').then(id => id.startsWith('custom/')));
      await page.getByRole("button", { name: "Add block after heading block", exact: true }).click();
      await page.screenshot({ path: dir + "/blocks.png" });
      await page.keyboard.press("Escape");
    }
    await page.getByRole("button", { name: "Video SOP", exact: true }).click();
    await page.getByRole("button", { name: "Create video", exact: true }).click();
    await page.getByText("Creating narration", { exact: true }).first().waitFor();
    await page.screenshot({ path: dir + (before ? "/before.png" : "/streaming.png") });
    const chat = page.getByRole("region", { name: "Screenpipe assistant" });
    if (!before) {
      assert(await chat.isVisible());
      assert(await chat.getByRole("button", { name: "Stop answer" }).isVisible());
      assert(await page.getByRole("region", { name: "Video SOP", exact: true }).isVisible());
    }
    await page.getByLabel("Narrated SOP preview", { exact: true }).waitFor();
    if (before) return;
    await chat.getByText(/Your video is ready on the page/).waitFor();
    const video = page.getByLabel("Narrated SOP preview", { exact: true });
    await video.evaluate(async element => {
      if (element.readyState < 1) await new Promise(resolve => element.addEventListener('loadedmetadata', resolve, {once:true}));
      element.currentTime = 0.5;
      await element.play(); element.pause();
    });
    await page.waitForFunction(() => {
      const v = document.querySelector('video[aria-label="Narrated SOP preview"]');
      return v?.textTracks[0]?.mode === 'showing' && v.textTracks[0].activeCues?.length > 0;
    });
    assert(await chat.isVisible());
    await page.screenshot({ path: dir + "/ready.png" });
    await chat.getByRole("button", { name: "Minimize chat" }).click();
    assert(await page.getByLabel("Narrated SOP preview").isVisible());
    await page.getByRole("region", {name:"Generated video block",exact:true}).hover();
    await page.screenshot({ path: dir + "/captions.png" });
    await page.getByRole("button", {name:"Move Generated video",exact:true}).dragTo(page.getByRole("region", {name:"Scene 1 heading block",exact:true}));
    assert.match(await page.locator('[aria-label="Video SOP"] [data-block-id]').first().getAttribute('data-block-id'), /^scene\//);
    await page.getByRole("button", {name:"Move Generated video",exact:true}).focus();
    await page.keyboard.press("Alt+ArrowUp");
    await page.getByRole("button", { name: "Create new video", exact: true }).click();
    await chat.getByText("Creating narration", { exact: true }).first().waitFor();
    await chat.getByRole("button", { name: "Stop answer" }).click();
    await page.getByRole("button", { name: "Create new video", exact: true }).waitFor({ state: "visible" });
    await page.setViewportSize({ width: 900, height: 800 });
    await page.screenshot({ path: dir + "/compact.png" });
    assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    assert.deepEqual(errors, []);
    console.log("PASS fictional browser fixture: add/edit/move blocks, visible default captions, video drag and keyboard reorder, chat generation, page result, chat stays open, minimize, repeat, stop and compact layout");
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
