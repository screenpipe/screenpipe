// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com
// Main app browser-mock, fictional workflows. Does not access a real microphone.
const { chromium } = require("playwright");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const base = process.env.WORKFLOW_APP_URL || "http://127.0.0.1:1457";
const out = process.env.WORKFLOW_SCREENSHOTS || "/tmp/workflow-questions";
fs.mkdirSync(out, { recursive: true });
(async () => {
 const browser = await chromium.launch({ headless: true, channel: "chrome", args: ["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream"] });
 try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, permissions: ["microphone"] });
  page.setDefaultTimeout(30000);
  const errors=[]; page.on("pageerror", e => { errors.push(e.message); console.error(e.stack); });
  const question = "Who reviews the synthesis before it is shared?";
  async function open() {
   await page.goto(base + "/home?mode=workflows");
   await page.getByText("Research synthesis", { exact: true }).waitFor();
   await page.getByRole("button", { name: "Do later", exact: true }).click({ timeout: 5000 }).catch(() => {});
   await page.getByRole("button", { name: "Open map", exact: true }).first().click();
   await page.getByRole("region", { name: "Open questions", exact: true }).waitFor();
  }
  const snap = name => page.screenshot({ path: `${out}/${name}.png`, animations: "disabled" });
  await open();
  const questions = page.getByRole("region", { name: "Open questions", exact: true });
  await questions.scrollIntoViewIfNeeded(); await snap("after-questions");
  assert.equal(await page.getByText("Evidence and limitations", {exact:true}).count(), 0);
  assert.equal(await page.getByText("Unresolved details", {exact:true}).count(), 0);
  const input=page.getByLabel(question,{exact:true});
  await input.fill("The project lead reviews the brief before it is shared with the team.");
  await page.getByLabel("What makes a source reliable enough to include?",{exact:true}).fill("Link to the original source and check the date. Keep conflicting findings visible.");
  await input.focus();
  assert.equal(await questions.getByRole("button",{name:/Dictate message/}).count(),1);
  await snap("after-answer-focused");
  let releaseTranscript;
  await page.route("**/listen?**", async route => {
    await new Promise(done => { releaseTranscript = done; });
    await route.fulfill({ json: { results: { channels: [{ alternatives: [{ transcript: "The team lead signs off." }] }] } } });
  });
  await input.fill("");
  await questions.getByRole("button", {name:/Dictate message/}).click();
  await page.getByTestId("composer-dictation-recording").waitFor();
  assert.equal(await page.getByRole("button",{name:"Save answers",exact:true}).isDisabled(),true);
  await snap("after-voice-recording");
  await page.getByRole("button",{name:/Finish dictation/}).click();
  await page.getByText("Transcribing", {exact:true}).waitFor();
  await snap("after-voice-transcribing");
  assert.equal(await page.getByRole("button",{name:"Save answers",exact:true}).isDisabled(),true);
  const transcriptDeadline = Date.now() + 10000;
  while (!releaseTranscript && Date.now() < transcriptDeadline) await page.waitForTimeout(50);
  assert.ok(releaseTranscript, "The mocked transcription endpoint was reached");
  releaseTranscript();
  await page.waitForFunction(() => [...document.querySelectorAll("textarea")].some(el=>el.value.includes("The team lead signs off.")));
  assert.equal(await input.inputValue(), "The team lead signs off.");
  await snap("after-voice-filled");
  await input.fill("The project lead reviews the brief before it is shared with the team.");
  // Fail only the fictional fixture's next persistence write, then retry.
  await page.evaluate(() => {
    const original = Storage.prototype.setItem;
    Storage.prototype.setItem = function(key, value) {
      if (key === "screenpipe:fictional-workflow-editor-preview") {
        Storage.prototype.setItem = original;
        throw new Error("Couldn’t save answers. Your draft is still here. Try again.");
      }
      return original.call(this, key, value);
    };
  });
  await page.getByRole("button",{name:"Save answers",exact:true}).click();
  await questions.getByRole("alert").waitFor();
  assert.equal(await input.inputValue(), "The project lead reviews the brief before it is shared with the team.");
  await snap("after-save-error");
  await page.getByRole("button",{name:"Save answers",exact:true}).click();
  await page.getByText("Answers saved for the next workflow update.",{exact:true}).waitFor().catch(async error => { console.error(await questions.innerText()); throw error; });
  await questions.scrollIntoViewIfNeeded();
  await snap("after-saved");
  await open();
  assert.equal(await input.inputValue(), "The project lead reviews the brief before it is shared with the team.");
  const play=page.getByRole("button",{name:/View recording for/}).first();
  await play.scrollIntoViewIfNeeded();
  assert.equal((await play.innerText()).trim(), "");
  const box=await play.boundingBox(); assert.ok(box.width <= 44 && box.height <= 44);
  await play.hover(); await snap("after-recording-icon");
  await play.click();
  await page.getByRole("button",{name:/Close recording for/}).waitFor();
  await snap("after-playback");
  await page.getByRole("button",{name:/Close recording for/}).click();
  await page.setViewportSize({width:390,height:844});
  await questions.scrollIntoViewIfNeeded(); await input.focus();
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  await snap("after-mobile");
  await page.emulateMedia({reducedMotion:"reduce"});
  await snap("after-reduced-motion");
  assert.deepEqual(errors,[]);
  console.log("PASS: generated questions, typing, voice affordance, explicit save, failed-save retry, reload, compact playback, mobile, reduced motion, synthetic dictation, no browser errors.");
 } finally { await browser.close(); }
})().catch(e=>{console.error(e);process.exitCode=1;});
