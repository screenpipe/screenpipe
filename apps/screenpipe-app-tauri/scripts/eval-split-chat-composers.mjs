// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com
// Run against bun run dev:web. Synthetic IPC only; no native process or AI request.
import { chromium } from "../../screenpipe-workflows-web/node_modules/playwright/index.mjs";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import assert from "node:assert/strict";
const output = process.env.SCREENPIPE_CHAT_UI_OUTPUT;
const captureStates = process.env.SCREENPIPE_CHAT_UI_CAPTURE_STATES?.split(",");
if (output) await mkdir(output, { recursive: true });
const browser = await chromium.launch({ headless: true, executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || undefined });
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
const errors = [];
page.on("pageerror", error => { errors.push(error.message); console.error(error.message); });
const pane = id => page.locator(`[data-chat-pane-id="${id}"]`);
const input = id => pane(id).locator("textarea");
const snap = async name => {
  if (!output || (captureStates && !captureStates.includes(name))) return;
  await page.waitForTimeout(350);
  await page.screenshot({ path: path.join(output, `split-${name}.png`) });
};
const event = (id, event) => page.evaluate(async ({ id, event }) => {
  await window.__SCREENPIPE_WEB_DEV_EMIT__("agent_event", { source: "pi", sessionId: id, event });
}, { id, event });
const start = async (id, text) => {
  await event(id, { type: "agent_start" });
  await event(id, { type: "message_start", message: { role: "assistant" } });
  await event(id, { type: "message_update", assistantMessageEvent: { type: "text_delta", delta: text } });
};
const waitCall = (cmd, id) => page.waitForFunction(({ cmd, id }) => window.__splitEval.calls.some(c => c.cmd === cmd && c.args.sessionId === id), { cmd, id });
const left = "browser-chat-4", right = "browser-chat-3";
try {
  await page.goto(`${process.env.SCREENPIPE_CHAT_UI_URL || "http://127.0.0.1:1420"}/home`, { timeout: 120000 });
  await page.waitForFunction(() => document.documentElement.dataset.screenpipeWebDev === "mock", { timeout: 60000 });
  assert.equal(await page.locator("html").getAttribute("data-screenpipe-web-dev"), "mock");
  await page.getByRole("button", { name: "Do later", exact: true }).click();
  await page.getByRole("dialog").waitFor({ state: "hidden" });
  await page.addStyleTag({ content: "nextjs-portal { display: none; }" });
  await page.evaluate(async () => {
    document.documentElement.classList.remove("dark"); document.documentElement.classList.add("light");
    const invoke = window.__TAURI_INTERNALS__.invoke;
    const state = window.__splitEval = { calls: [], queues: {}, delay: false, fail: false };
    const files = new Map();
    window.__TAURI_INTERNALS__.invoke = async (cmd, args = {}, options) => {
      // The base browser mock is read-only for chat files. Retain this eval's
      // writes so cross-window save notifications read the actual new turn.
      if (cmd === "plugin:fs|write_text_file") {
        files.set(decodeURIComponent(options.headers.path), new Uint8Array(args));
        return null;
      }
      if (cmd === "plugin:fs|rename" && files.has(args.oldPath)) {
        files.set(args.newPath, files.get(args.oldPath)); files.delete(args.oldPath); return null;
      }
      if (cmd === "plugin:fs|exists" && files.has(args.path)) return true;
      if (cmd === "plugin:fs|remove" && files.has(args.path)) { files.delete(args.path); return null; }
      if (cmd === "plugin:dialog|open") return ["/mock/split-notes.txt"];
      if (cmd === "plugin:fs|read_file" && args.path === "/mock/split-notes.txt") {
        if (state.delayFile) await new Promise(r => setTimeout(r, 1500));
        return new TextEncoder().encode("Synthetic notes for the right chat only.");
      }
      if (cmd.startsWith("pi_")) state.calls.push({ cmd, args });
      if (state.delay && cmd === "plugin:fs|read_text_file" && String(args.path).includes("browser-chat-3")) await new Promise(r => setTimeout(r, 900));
      if (["plugin:fs|read_text_file", "plugin:fs|read_file"].includes(cmd)) {
        if (files.has(args.path)) return files.get(args.path);
        const result = await invoke(cmd, args, options);
        // Exercise ordinary Screenpipe chats, not the read-only imported-agent
        // feed represented by the default history fixtures.
        if (String(args.path).endsWith(".json") && String(args.path).includes("/chats/")) {
          try {
            const chat = JSON.parse(new TextDecoder().decode(new Uint8Array(result)));
            delete chat.importedFrom;
            return new TextEncoder().encode(JSON.stringify(chat));
          } catch { /* A new chat has no disk file yet. */ }
        }
        return result;
      }
      if (cmd === "pi_info" || cmd === "pi_start") return { running: true, busy: false, projectDir: "/Users/screenpipe", pid: 4242, sessionId: args.sessionId, startupError: null };
      if (cmd === "pi_check") return { available: true, path: "/mock/pi" };
      if (cmd === "pi_prompt") {
        if (state.fail) throw "Synthetic connection interruption";
        return "ok";
      }
      if (cmd === "pi_queue_prompt") {
        const id = `queued-${state.calls.length}`;
        (state.queues[args.sessionId] ??= []).push({ id, preview: args.displayPreview || args.message.slice(-200), queuedAtMs: Date.now() });
        return id;
      }
      if (cmd === "pi_pending") return state.queues[args.sessionId] ?? [];
      if (cmd === "pi_abort" || cmd === "pi_abort_active") return null;
      return invoke(cmd, args, options);
    };
    const rid = await invoke("plugin:store|get_store", { path: "/Users/screenpipe/.screenpipe/store.bin" });
    const [settings] = await invoke("plugin:store|get", { rid, key: "settings" });
    await invoke("plugin:store|set", { rid, key: "settings", value: { ...settings, showChatSuggestions: false, aiPresets: [{ id: "split-fixture", model: "gpt-4o-mini", provider: "openai", url: "http://127.0.0.1:9999", apiKey: "synthetic-browser-fixture", prompt: "", defaultPreset: true, maxContextChars: 128000 }, { id: "split-alternate", model: "gpt-4.1-mini", provider: "openai", url: "http://127.0.0.1:9999", apiKey: "synthetic-browser-fixture", prompt: "", defaultPreset: false, maxContextChars: 128000 }] } });
  });
  await page.getByRole("button", { name: /Investigate audio device switching/ }).first().click();
  await page.getByRole("tab", { name: "Investigate audio device switching", exact: true }).waitFor();
  await page.getByRole("button", { name: /Draft launch announcement/ }).first().click();
  await page.getByRole("tab", { name: "Draft launch announcement", exact: true }).waitFor();
  await page.getByRole("tab", { name: "Investigate audio device switching", exact: true }).click({ button: "right" });
  await page.getByRole("menuitem", { name: "Open in split", exact: true }).click();
  await page.getByTestId("chat-split-pane").waitFor();
  await input(left).fill("Keep the launch draft here.");
  await input(right).fill("Compare the two device changes.");
  assert.equal(await input(left).inputValue(), "Keep the launch draft here.");
  for (const id of [left, right]) {
    assert.equal(await pane(id).getByRole("button", { name: "Add attachments and filters", exact: true }).count(), 1);
    assert.equal(await pane(id).getByRole("button", { name: /^Dictate message/ }).count(), 1);
    assert.equal(await pane(id).getByRole("combobox").count(), 1);
  }
  await snap("drafts-light");
  await pane(right).getByRole("button", { name: "Add attachments and filters", exact: true }).click();
  await page.getByRole("button", { name: "Add photos & files", exact: true }).waitFor();
  await snap("add-menu");
  await page.getByRole("button", { name: "Add photos & files", exact: true }).click();
  await pane(right).getByText("split-notes.txt", { exact: true }).waitFor();
  assert.equal(await pane(left).getByText("split-notes.txt", { exact: true }).count(), 0);
  assert.equal(await input(left).inputValue(), "Keep the launch draft here.");
  await snap("attachment");
  await pane(right).getByRole("button", { name: "Remove split-notes.txt", exact: true }).click();
  await page.evaluate(() => { window.__splitEval.delayFile = true; });
  await pane(right).getByRole("button", { name: "Add attachments and filters", exact: true }).click();
  await page.getByRole("button", { name: "Add photos & files", exact: true }).click();
  await snap("attachment-loading");
  await page.getByRole("tab", { name: "Investigate audio device switching", exact: true }).click();
  await pane(right).getByRole("button", { name: "Remove split-notes.txt", exact: true }).waitFor();
  assert.equal(await pane(left).getByText("split-notes.txt", { exact: true }).count(), 0);
  await pane(right).getByRole("button", { name: "Remove split-notes.txt", exact: true }).click();
  await page.getByRole("tab", { name: "Draft launch announcement", exact: true }).click();
  // Repeat from the foreground composer: a late read must not follow it into
  // the newly selected chat when React reuses that composer instance.
  await pane(left).getByRole("button", { name: "Add attachments and filters", exact: true }).click();
  await page.getByRole("button", { name: "Add photos & files", exact: true }).click();
  await page.getByRole("tab", { name: "Investigate audio device switching", exact: true }).click();
  await pane(left).getByRole("button", { name: "Remove split-notes.txt", exact: true }).waitFor();
  assert.equal(await pane(right).getByText("split-notes.txt", { exact: true }).count(), 0);
  await pane(left).getByRole("button", { name: "Remove split-notes.txt", exact: true }).click();
  await page.getByRole("tab", { name: "Draft launch announcement", exact: true }).click();
  await page.evaluate(() => { window.__splitEval.delayFile = false; });
  await pane(right).getByRole("button", { name: "Add attachments and filters", exact: true }).click();
  await page.getByRole("button", { name: /^@today/ }).click();
  assert((await input(right).inputValue()).includes("@today"));
  assert.equal(await input(left).inputValue(), "Keep the launch draft here.");
  await snap("filter");
  await page.keyboard.press("Escape");
  await input(right).fill("Compare the two device changes.");
  await pane(right).getByRole("combobox").click();
  await snap("model-menu");
  await page.keyboard.press("Escape");
  // A deterministic in-memory microphone: no device capture or upload.
  await page.evaluate(() => {
    window.__splitEval.micRequests = 0;
    Object.defineProperty(navigator, "mediaDevices", { configurable: true, value: { getUserMedia: async () => { window.__splitEval.micRequests++; if (window.__splitEval.micDenied) throw new DOMException("Synthetic denial", "NotAllowedError"); return { getTracks: () => [{ stop() {} }] }; } } });
    window.AudioContext = undefined;
    window.webkitAudioContext = undefined;
    window.MediaRecorder = class {
      static isTypeSupported() { return true; }
      state = "inactive";
      mimeType = "audio/webm";
      start() { this.state = "recording"; }
      stop() { this.state = "inactive"; this.ondataavailable?.({ data: new Blob(["synthetic audio"], { type: this.mimeType }) }); queueMicrotask(() => this.onstop?.()); }
    };
    const originalFetch = window.fetch;
    window.fetch = async (url, options) => String(url).includes("/listen?")
      ? new Response(JSON.stringify({ results: { channels: [{ alternatives: [{ transcript: "Dictated into the right chat." }] }] } }), { status: 200, headers: { "Content-Type": "application/json" } })
      : originalFetch(url, options);
  });
  await input(right).focus();
  await input(right).press("Meta+d");
  await pane(right).getByTestId("composer-dictation-recording").waitFor();
  assert.equal(await pane(left).getByTestId("composer-dictation-recording").count(), 0);
  assert.equal(await page.evaluate(() => window.__splitEval.micRequests), 1);
  await snap("dictation");
  await pane(right).getByRole("button", { name: "Finish dictation", exact: true }).click();
  await page.waitForFunction(() => [...document.querySelectorAll('[data-chat-pane-id="browser-chat-3"] textarea')].some(node => node.value.includes("Dictated into the right chat.")));
  assert.equal(await input(left).inputValue(), "Keep the launch draft here.");
  await snap("dictated");
  await page.evaluate(() => { window.__splitEval.micDenied = true; });
  await pane(right).getByRole("button", { name: /^Dictate message/ }).click();
  await pane(right).getByRole("alert").waitFor();
  await snap("dictation-error");
  await pane(right).getByRole("button", { name: "Dismiss dictation error", exact: true }).click();
  await page.evaluate(() => { window.__splitEval.micDenied = false; });
  await input(right).fill("Compare the two device changes.");
  await page.evaluate(() => { document.documentElement.classList.remove("light"); document.documentElement.classList.add("dark"); });
  await snap("drafts-dark");
  await page.evaluate(() => { document.documentElement.classList.remove("dark"); document.documentElement.classList.add("light"); });
  await page.setViewportSize({ width: 1000, height: 780 });
  assert((await input(left).boundingBox()).width > 220);
  assert((await input(right).boundingBox()).width > 220);
  await snap("compact");
  await page.setViewportSize({ width: 1440, height: 1000 });
  const beforeLeft = await pane(left).boundingBox(), beforeRight = await pane(right).boundingBox();
  await page.evaluate(() => { window.__splitEval.delay = true; });
  await pane(right).getByRole("button", { name: "Send message", exact: true }).click();
  await page.getByLabel("Preparing chat", { exact: true }).waitFor();
  await snap("preparing");
  await waitCall("pi_prompt", right);
  await page.evaluate(() => { window.__splitEval.delay = false; });
  assert.equal(await input(left).inputValue(), "Keep the launch draft here.");
  assert(Math.abs((await pane(left).boundingBox()).x - beforeLeft.x) < 2);
  assert(Math.abs((await pane(right).boundingBox()).x - beforeRight.x) < 2);
  assert.equal(await page.evaluate(() => window.__splitEval.calls.filter(c => c.cmd === "pi_prompt" && c.args.sessionId === "browser-chat-4").length), 0);
  await snap("right-sent");
  await start(right, "The output device changed first. I am checking the input-device timeline next.");
  await start(left, "The launch summary is ready. I am comparing the final wording with the release notes.");
  await pane(right).getByText("The output device changed first. I am checking the input-device timeline next.", { exact: true }).waitFor();
  await pane(left).getByText("The launch summary is ready. I am comparing the final wording with the release notes.", { exact: true }).waitFor();
  await snap("both-streaming");
  await input(left).fill("Keep the draft under 100 words.");
  await pane(left).getByRole("button", { name: "Send message", exact: true }).click();
  await waitCall("pi_queue_prompt", left);
  await snap("queued-left");
  await pane(right).getByRole("button", { name: "Stop reply", exact: true }).click();
  await page.waitForFunction(() => window.__splitEval.calls.some(c => ["pi_abort", "pi_abort_active"].includes(c.cmd) && c.args.sessionId === "browser-chat-3"));
  assert.equal(await page.evaluate(() => window.__splitEval.calls.filter(c => ["pi_abort", "pi_abort_active"].includes(c.cmd) && c.args.sessionId === "browser-chat-4").length), 0);
  await event(right, { type: "agent_end" });
  await event(left, { type: "agent_end" });
  await page.evaluate(() => { window.__splitEval.queues = {}; });
  await snap("stopped-right");
  await input(left).fill("Retain this draft after closing the split.");
  await page.getByRole("button", { name: "Close split view", exact: true }).click();
  await snap("split-closed");
  await page.getByRole("tab", { name: "Draft launch announcement", exact: true }).click({ button: "right" });
  await page.getByRole("menuitem", { name: "Open in split", exact: true }).click();
  assert.equal(await input(left).inputValue(), "Retain this draft after closing the split.");
  await snap("draft-restored");
  // A late error in the background pane must preserve its editable draft.
  await event(left, { type: "message_end", message: { role: "assistant", stopReason: "error", errorMessage: "Connection interrupted. Your draft is ready to retry." } });
  await pane(left).getByRole("status").filter({ hasText: "Connection interrupted" }).waitFor();
  await snap("error-draft");
  await pane(left).getByRole("button", { name: "Send message", exact: true }).click();
  await waitCall("pi_prompt", left);
  await start(left, "Connection restored. Here is the revised launch summary.");
  await page.waitForTimeout(150);
  await event(left, { type: "agent_end" });
  await snap("recovered");
  await page.getByRole("button", { name: "Close split view", exact: true }).click();
  await page.getByRole("button", { name: "New chat tab", exact: true }).click();
  await page.getByRole("tab", { name: "New chat", exact: true }).waitFor();
  await page.locator("[data-firstrun-target=messages] textarea").fill("A new chat draft");
  await page.getByRole("tab", { name: "Draft launch announcement", exact: true }).click();
  await page.getByRole("tab", { name: "New chat", exact: true }).click({ button: "right" });
  await page.getByRole("menuitem", { name: "Open in split", exact: true }).click();
  await page.getByText("Start a conversation here.", { exact: true }).waitFor();
  await page.getByTestId("chat-split-pane").getByRole("textbox").fill("");
  await snap("empty");
  const emptyInput = page.getByTestId("chat-split-pane").getByRole("textbox");
  await emptyInput.fill("A draft in a new split chat.");
  await emptyInput.press("Alt+Meta+r");
  await page.getByRole("textbox", { name: "Rename New chat", exact: true }).waitFor();
  await snap("focused-shortcut");
  await page.keyboard.press("Escape");
  const newId = await page.getByTestId("chat-split-pane").getAttribute("data-chat-pane-id");
  const oldLeft = await pane(left).boundingBox(), oldNew = await pane(newId).boundingBox();
  await pane(newId).getByRole("combobox").click();
  await page.getByRole("option").filter({ hasText: "split-alternate" }).click();
  await page.waitForFunction(id => document.querySelector(`[data-chat-pane-id="${id}"] [role="combobox"]`)?.textContent.includes("gpt-4.1-mini"), newId);
  assert((await pane(left).getByRole("combobox").innerText()).includes("gpt-4o-mini"));
  assert(Math.abs((await pane(left).boundingBox()).x - oldLeft.x) < 2);
  assert(Math.abs((await pane(newId).boundingBox()).x - oldNew.x) < 2);
  await snap("different-models");
  assert.deepEqual(errors, []);
  console.log("PASS: independent drafts, direct send, stable pane positions, concurrent streams, queue/stop isolation, close/reopen, error recovery, empty chat, focused shortcuts, shared toolbar, scoped files/filters/models/dictation, late extraction, light/dark/compact");
} catch (error) { console.error((await page.locator("body").innerText()).slice(-4000)); throw error; } finally { await browser.close(); }
