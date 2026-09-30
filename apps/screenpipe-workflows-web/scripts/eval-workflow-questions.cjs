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
  // Synthetic WebRTC only; microphone media is Chrome's fake device.
  await page.addInitScript(() => {
    window.RTCPeerConnection = class {
      iceGatheringState = "complete"; connectionState = "connected";
      addTrack() {} close() { window.__voicePeerClosed = true; }
      createDataChannel() { this.channel = { readyState: "open", send() {}, close() {} }; window.__voiceChannel = this.channel; return this.channel; }
      async createOffer() { return { type: "offer", sdp: "v=0\r\noffer" }; }
      async setLocalDescription(offer) { this.localDescription = offer; }
      async setRemoteDescription() { this.channel.onmessage({ data: JSON.stringify({ type: "session.started" }) }); }
    };
  });
  let hangups = 0, releaseFill;
  await page.route("**/__fixtures/workflow-voice", async route => {
    if (route.request().method() === "DELETE") { hangups++; await route.fulfill({ status: 204 }); return; }
    await route.fulfill({ json: { sdp: "v=0\r\nanswer", call_token: "fictional-session", expires_at: Date.now()+120000 } });
  });
  await page.route("**/__fixtures/workflow-voice-fill", async route => {
    await new Promise(resolve => { releaseFill = resolve; });
    await route.fulfill({ json: [
      { question: "Who reviews the synthesis before it is shared?", answer: "The project lead reviews it before sharing.", quote: "The project lead reviews it" },
      { question: "What makes a source reliable enough to include?", answer: "Use original sources and check their dates.", quote: "Use original sources and check their dates" },
      { question: "Anything else we should know?", answer: "Keep conflicting findings visible in the brief.", quote: "Keep conflicting findings visible" },
    ] });
  });
  const question = "Who reviews the synthesis before it is shared?";
  async function open() {
   await page.goto(base + "/home?mode=workflows");
   await page.getByText("Research synthesis", { exact: true }).waitFor();
   await page.getByRole("button", { name: "Do later", exact: true }).click({ timeout: 5000 }).catch(() => {});
   await page.getByRole("button", { name: "Open map", exact: true }).first().click();
   await page.getByRole("region", { name: "Questions and feedback", exact: true }).waitFor();
  }
  let formBounds;
  const snap = async name => {
    if (["after-questions", "after-voice-recording", "after-voice-filling", "after-voice-filled"].includes(name)) {
      const box = await page.getByRole("region",{name:"Questions and feedback",exact:true}).boundingBox();
      if (formBounds) { assert.ok(Math.abs(box.x-formBounds.x)<2, "Voice must not shift the form horizontally"); assert.ok(Math.abs(box.width-formBounds.width)<2); }
      else formBounds = box;
    }
    return page.screenshot({ path: `${out}/${name}.png`, animations: "disabled" });
  };
  await open();
  const questions = page.getByRole("region", { name: "Questions and feedback", exact: true });
  await questions.scrollIntoViewIfNeeded(); await snap("after-questions");
  assert.equal(await page.getByText("Evidence and limitations", {exact:true}).count(), 0);
  assert.equal(await page.getByText("Unresolved details", {exact:true}).count(), 0);
  const input=page.getByLabel(question,{exact:true});
  await input.fill("The project lead reviews the brief before it is shared with the team.");
  await page.getByLabel("What makes a source reliable enough to include?",{exact:true}).fill("Link to the original source and check the date. Keep conflicting findings visible.");
  await input.focus();
  assert.equal(await questions.getByRole("button",{name:"Answer with voice"}).count(),1);
  await snap("after-answer-focused");
  // Fresh session avoids carrying the deliberate manual locks from the focus check.
  await open(); await questions.scrollIntoViewIfNeeded();
  await questions.getByRole("button", {name:"Answer with voice"}).click();
  await page.getByText("Listening", {exact:true}).waitFor();
  assert.equal(await page.getByRole("button",{name:"Save answers",exact:true}).isDisabled(),true);
  await snap("after-voice-recording");
  await page.evaluate(() => window.__voiceChannel.onmessage({ data: JSON.stringify({ type: "session.input_transcript.delta", event_id: "one", delta: "The project lead reviews it before sharing. Use original sources and check their dates. Keep conflicting findings visible." }) }));
  await page.getByText("Updating answers and summary…", {exact:true}).waitFor();
  await snap("after-voice-filling");
  await page.getByRole("button",{name:"Stop recording"}).click();
  await page.waitForFunction(() => window.__voicePeerClosed === true);
  const deadline = Date.now()+10000;
  while (!releaseFill && Date.now()<deadline) await page.waitForTimeout(50);
  assert.ok(releaseFill); releaseFill();
  await page.waitForFunction(() => [...document.querySelectorAll("textarea")].some(el=>el.value.includes("The project lead reviews it before sharing.")));
  assert.equal(await input.inputValue(), "The project lead reviews it before sharing.");
  assert.equal(await page.getByLabel("What makes a source reliable enough to include?",{exact:true}).inputValue(), "Use original sources and check their dates.");
  assert.equal(await page.getByLabel("Anything else we should know?",{exact:true}).inputValue(), "Keep conflicting findings visible in the brief.");
  assert.ok(hangups > 0);
  await snap("after-voice-filled");
  await page.getByRole("button",{name:"Undo voice answer: Who reviews the synthesis before it is shared?"}).click();
  assert.equal(await input.inputValue(), "");
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
  await questions.evaluate(node => node.scrollIntoView({block:"start"}));
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  await snap("after-mobile");
  await page.route("**/__fixtures/workflow-voice", route => route.fulfill({status:503,json:{error:"Unavailable"}}));
  await questions.getByRole("button",{name:"Answer with voice"}).click();
  await questions.getByRole("alert").waitFor();
  await questions.evaluate(node => node.scrollIntoView({block:"start"}));
  await snap("after-voice-error");
  assert.equal(await input.inputValue(), "The project lead reviews the brief before it is shared with the team.");
  await page.emulateMedia({reducedMotion:"reduce"});
  await snap("after-reduced-motion");
  assert.deepEqual(errors,[]);
  console.log("PASS: generated questions, typing, voice affordance, explicit save, failed-save retry, reload, compact playback, mobile, reduced motion, synthetic Live session, multi-field fill, undo, microphone cleanup, no browser errors.");
 } finally { await browser.close(); }
})().catch(e=>{console.error(e);process.exitCode=1;});
