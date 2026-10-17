// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com
// Run against bun run dev:web. Synthetic IPC only; no native process or AI request.
//
// Sends a first message and a follow-up through the real chat send path and
// samples every frame from Send until the reply starts. The user's message must
// sit above the turn status, keep one element and one position through the
// durable-row swap, and the status must never report the previous answer.
//
//   bun scripts/eval-chat-pending-turn.mjs
//
// SCREENPIPE_CHAT_UI_URL points at another dev:web server. WebKit, the macOS
// app's engine, is the default; SCREENPIPE_EVAL_BROWSER=chromium switches.
// SCREENPIPE_EVAL_FRAMES=<file> writes the sampled frames as JSON.
import { writeFileSync } from "node:fs";
import { chromium, webkit } from "../../screenpipe-workflows-web/node_modules/playwright/index.mjs";

const url = process.env.SCREENPIPE_CHAT_UI_URL || "http://127.0.0.1:1420";
const engine = process.env.SCREENPIPE_EVAL_BROWSER === "chromium" ? chromium : webkit;
// Each send reads Pi liveness twice before its durable row lands. Slowing that
// read makes the pending window as long as a real cold start.
const LIVENESS_DELAY_MS = 700;

const browser = await engine.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1312, height: 925 } });
const errors = [];
page.on("pageerror", (error) => errors.push(error.message));

async function emit(event) {
  await page.evaluate(async (event) => {
    const sessionId = document.querySelector("[data-chat-pane-id]")?.getAttribute("data-chat-pane-id");
    await window.__SCREENPIPE_WEB_DEV_EMIT__("agent_event", { source: "pi", sessionId, event });
  }, event);
}

async function sendAndSample(prompt, reply) {
  await page.evaluate((prompt) => {
    const frames = (window.__pendingTurnFrames = []);
    const rect = (el) => {
      if (!el) return null;
      const { top, bottom } = el.getBoundingClientRect();
      return { top: Math.round(top * 10) / 10, bottom: Math.round(bottom * 10) / 10 };
    };
    const sample = () => {
      const row = [...document.querySelectorAll(
        '[data-testid="chat-pending-user-message"], [data-testid="chat-message-user"]',
      )].find((el) => el.textContent.includes(prompt));
      if (row && !window.__pendingTurnRow) window.__pendingTurnRow = row;
      const assistants = [...document.querySelectorAll('[data-testid="chat-message-assistant"]')];
      const status = document.querySelector('[data-testid="chat-turn-status"]');
      frames.push({
        ms: Math.round(performance.now()),
        row: rect(row),
        sameRow: row ? row === window.__pendingTurnRow : null,
        pending: row?.dataset.testid === "chat-pending-user-message",
        status: rect(status),
        statusText: status?.textContent ?? null,
        previousAnswer: rect(assistants[0]),
        replyStarted: row ? assistants.some((el) =>
          row.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING) : false,
      });
    };
    window.__pendingTurnRow = null;
    window.__pendingTurnObserver?.disconnect();
    window.__pendingTurnObserver = new MutationObserver(sample);
    window.__pendingTurnObserver.observe(document.body, {
      subtree: true, childList: true, attributes: true, characterData: true,
    });
    const tick = () => {
      sample();
      if (window.__pendingTurnObserver) window.__pendingTurnRaf = requestAnimationFrame(tick);
    };
    tick();
  }, prompt);

  const promptsBefore = await page.evaluate(() => window.__pendingTurnEval.prompts);
  const composer = page.locator("[data-firstrun-target=messages] textarea");
  await composer.fill(prompt);
  await composer.press("Enter");
  await page.waitForFunction((n) => window.__pendingTurnEval.prompts > n, promptsBefore);
  // Hold the durable-row state long enough for any entrance animation to run.
  await page.waitForTimeout(600);
  await emit({ type: "agent_start" });
  await emit({ type: "message_start", message: { role: "assistant" } });
  await emit({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: reply } });
  await page.getByText(reply).waitFor();
  await page.waitForTimeout(200);
  await emit({ type: "agent_end" });
  await page.waitForTimeout(400);

  return page.evaluate(() => {
    window.__pendingTurnObserver.disconnect();
    window.__pendingTurnObserver = null;
    cancelAnimationFrame(window.__pendingTurnRaf);
    return window.__pendingTurnFrames;
  });
}

const spread = (values) => (values.length ? Math.max(...values) - Math.min(...values) : 0);

function check(name, frames, { followUp = false } = {}) {
  const start = frames.findIndex((f) => f.row);
  const end = frames.findIndex((f) => f.replyStarted);
  const waiting = frames.slice(start, end);
  const withStatus = waiting.filter((f) => f.status);
  const failures = [];
  if (start < 0 || end <= start) failures.push("never observed the message waiting for its reply");
  if (!waiting.some((f) => f.pending)) failures.push("never observed the pending row");
  if (!waiting.some((f) => !f.pending)) failures.push("never observed the durable row before the reply");

  const above = withStatus.filter((f) => f.status.top < f.row.bottom);
  if (above.length) failures.push(`status above the message in ${above.length} frame(s)`);
  if (waiting.some((f) => f.sameRow === false)) failures.push("the durable row replaced the pending element");
  const rowTravel = spread(waiting.map((f) => f.row.top));
  if (rowTravel > 1) failures.push(`message moved ${rowTravel}px while waiting`);
  const statusTravel = spread(withStatus.map((f) => f.status.top));
  if (statusTravel > 1) failures.push(`status moved ${statusTravel}px while waiting`);
  if (followUp) {
    const writing = withStatus.filter((f) => /writing/.test(f.statusText));
    if (writing.length) failures.push(`status said "${writing[0].statusText}" before the reply`);
    const answerResize = spread(waiting.filter((f) => f.previousAnswer)
      .map((f) => f.previousAnswer.bottom - f.previousAnswer.top));
    if (answerResize > 1) failures.push(`previous answer changed height by ${answerResize}px`);
  }

  const labels = [...new Set(withStatus.map((f) => f.statusText))];
  console.log(`${failures.length ? "FAIL" : "PASS"} ${name}: ${waiting.length} frames, ` +
    `${waiting.filter((f) => f.pending).length} pending, message travel ${rowTravel}px, ` +
    `status travel ${statusTravel}px, labels ${JSON.stringify(labels)}`);
  for (const failure of failures) console.log(`  - ${failure}`);
  return failures.length === 0;
}

let ok = false;
try {
  await page.goto(`${url}/home`, { timeout: 120_000 });
  await page.waitForFunction(() => document.documentElement.dataset.screenpipeWebDev === "mock", null, { timeout: 60_000 });
  await page.getByRole("button", { name: "Do later", exact: true }).click();
  await page.getByRole("dialog").waitFor({ state: "hidden" });
  await page.addStyleTag({ content: "nextjs-portal { display: none; }" });
  await page.evaluate(async (livenessDelayMs) => {
    const invoke = window.__TAURI_INTERNALS__.invoke;
    const state = (window.__pendingTurnEval = { prompts: 0 });
    const files = new Map();
    window.__TAURI_INTERNALS__.invoke = async (cmd, args = {}, options) => {
      // The base browser mock is read-only for chat files.
      if (cmd === "plugin:fs|write_text_file") {
        files.set(decodeURIComponent(options.headers.path), new Uint8Array(args));
        return null;
      }
      if (cmd === "plugin:fs|rename" && files.has(args.oldPath)) {
        files.set(args.newPath, files.get(args.oldPath));
        files.delete(args.oldPath);
        return null;
      }
      if (cmd === "plugin:fs|exists" && files.has(args.path)) return true;
      if (["plugin:fs|read_text_file", "plugin:fs|read_file"].includes(cmd) && files.has(args.path)) {
        return files.get(args.path);
      }
      const running = { running: true, busy: false, projectDir: "/Users/screenpipe", pid: 4242, sessionId: args.sessionId, startupError: null };
      if (cmd === "pi_info") {
        await new Promise((resolve) => setTimeout(resolve, livenessDelayMs));
        return running;
      }
      if (cmd === "pi_start") return running;
      if (cmd === "pi_check") return { available: true, path: "/mock/pi" };
      if (cmd === "pi_prompt") {
        state.prompts += 1;
        return "ok";
      }
      if (cmd === "pi_pending") return [];
      if (cmd === "pi_abort" || cmd === "pi_abort_active") return null;
      return invoke(cmd, args, options);
    };
    const rid = await invoke("plugin:store|get_store", { path: "/Users/screenpipe/.screenpipe/store.bin" });
    const [settings] = await invoke("plugin:store|get", { rid, key: "settings" });
    await invoke("plugin:store|set", { rid, key: "settings", value: {
      ...settings,
      showChatSuggestions: false,
      aiPresets: [{ id: "pending-turn-fixture", model: "gpt-4o-mini", provider: "openai", url: "http://127.0.0.1:9999", apiKey: "synthetic-browser-fixture", prompt: "", defaultPreset: true, maxContextChars: 128000 }],
    } });
  }, LIVENESS_DELAY_MS);

  const first = await sendAndSample("Give me a summary of what I did today.", "First synthetic reply.");
  const followUp = await sendAndSample("And what about yesterday?", "Second synthetic reply.");
  const results = [check("first message", first), check("follow-up", followUp, { followUp: true })];
  ok = results.every(Boolean);
  if (process.env.SCREENPIPE_EVAL_FRAMES) {
    writeFileSync(process.env.SCREENPIPE_EVAL_FRAMES, JSON.stringify({ first, followUp }));
  }
  if (errors.length) {
    console.log(`page errors: ${errors.join(" | ")}`);
    ok = false;
  }
} finally {
  await browser.close();
}
process.exit(ok ? 0 : 1);
