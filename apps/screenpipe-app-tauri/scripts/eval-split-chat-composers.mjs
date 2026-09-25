// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com
// Run against bun run dev:web. Synthetic IPC only; no native process or AI request.
import { chromium } from "../../screenpipe-workflows-web/node_modules/playwright/index.mjs";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import assert from "node:assert/strict";
const output = process.env.SCREENPIPE_CHAT_UI_OUTPUT;
if (output) await mkdir(output, { recursive: true });
const browser = await chromium.launch({ headless: true, executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || undefined });
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
const errors = [];
page.on("pageerror", error => errors.push(error.message));
const pane = id => page.locator(`[data-chat-pane-id="${id}"]`);
const input = id => pane(id).locator("textarea");
const snap = async name => {
  if (!output) return;
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
    await invoke("plugin:store|set", { rid, key: "settings", value: { ...settings, showChatSuggestions: false, aiPresets: [{ id: "split-fixture", model: "gpt-4o-mini", provider: "openai", url: "http://127.0.0.1:9999", apiKey: "synthetic-browser-fixture", prompt: "", defaultPreset: true, maxContextChars: 128000 }] } });
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
  await snap("drafts-light");
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
  await pane(left).getByRole("button", { name: "Queue message", exact: true }).click();
  await waitCall("pi_queue_prompt", left);
  await snap("queued-left");
  await pane(right).getByRole("button", { name: "Stop this chat", exact: true }).click();
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
  assert.deepEqual(errors, []);
  console.log("PASS: independent drafts, direct send, stable pane positions, concurrent streams, queue/stop isolation, close/reopen, error recovery, empty chat, focused shortcuts, light/dark/compact");
} finally { await browser.close(); }
