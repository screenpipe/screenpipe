// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com

// #6735 moved generation and retry ownership to the native app. These tests
// seed its durable record and verify the real renderer projection. Actual
// native generation is covered by first-run-ai-summary.spec.ts; a localStorage
// timestamp can no longer drive or retry that job.
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { E2E_DATA_DIR } from "../helpers/app-launcher.js";
import { invokeOrThrow } from "../helpers/tauri.js";
import { openHomeWindow, reloadAndWaitForHome, t, waitForAppReady } from "../helpers/test-utils.js";
import { saveScreenshot } from "../helpers/screenshot-utils.js";

const LEARNING_STORAGE_KEY = "screenpipe.first-run.learning-window.v1";
const BANNER = '[data-testid="first-run-learning-banner"]';
const SUMMARY_CHAT_ID = "first-run-e2e";
const SUMMARY_TEXT = "Screenpipe saw work across Arc and Cursor. You reviewed onboarding and prepared the next app release.";
const SUMMARY_CHAT_PATH = join(E2E_DATA_DIR, "chats", `${SUMMARY_CHAT_ID}.json`);
let originalOnboarding: Record<string, unknown>;
let storeRid: number;

const writeSummaryConversation = () => {
  mkdirSync(join(E2E_DATA_DIR, "chats"), { recursive: true });
  const now = Date.now();
  writeFileSync(
    SUMMARY_CHAT_PATH,
    JSON.stringify(
      {
        id: SUMMARY_CHAT_ID,
        title: "What screenpipe saw so far",
        titleSource: "fallback",
        messages: [
          {
            id: `${SUMMARY_CHAT_ID}-assistant`,
            role: "assistant",
            content: SUMMARY_TEXT,
            timestamp: now,
          },
        ],
        createdAt: now,
        updatedAt: now,
        lastContentAt: now,
        lastViewedAt: 0,
        kind: "chat",
      },
      null,
      2,
    ),
  );
};


async function nativeState(): Promise<Record<string, unknown>> {
  return invokeOrThrow("get_onboarding_status");
}

async function persistNativeState(value: Record<string, unknown>): Promise<void> {
  await invokeOrThrow("plugin:store|set", { rid: storeRid, key: "onboarding", value });
  await invokeOrThrow("plugin:store|save", { rid: storeRid });
  await invokeOrThrow("plugin:event|emit", { event: "first-run-summary-state", payload: null });
}

async function openNativePhase(phase: "learning" | "writing" | "ready" | "empty") {
  const startedAt = new Date().toISOString();
  await persistNativeState({
    ...originalOnboarding,
    isCompleted: true, completedAt: startedAt, currentStep: null,
    trialActivationFreshInstall: false,
    firstRunSummaryPhase: phase, firstRunSummaryStartedAt: startedAt,
    firstRunSummaryChatId: phase === "ready" ? SUMMARY_CHAT_ID : null,
    firstRunSummaryError: null,
    firstRunSummaryNotificationId: phase === "ready" ? `first-run-summary-ready-${SUMMARY_CHAT_ID}` : null,
    firstRunSummaryNotificationSentAt: phase === "ready" ? startedAt : null,
  });
  // Home can retain a locally dismissed card from a prior test. Give this
  // distinct native job a fresh view state, then await an actual navigation.
  await browser.execute((key: string, stamp: string) => {
    localStorage.setItem(key, JSON.stringify({
      phase: "learning", startedAt: stamp, showProgress: true,
      seededAt: null, chatId: null,
    }));
  }, LEARNING_STORAGE_KEY, startedAt);
  await reloadAndWaitForHome();
  await browser.waitUntil(async () =>
    (await $(BANNER).getAttribute("data-phase").catch(() => null)) === phase,
    { timeout: t(20_000), timeoutMsg: `Home did not project native ${phase}` },
  );
  return startedAt;
}

describe("Native first-run summary projection", function () {
  this.timeout(t(120_000));

  before(async () => {
    await waitForAppReady();
    await openHomeWindow();
    storeRid = await invokeOrThrow<number>("plugin:store|get_store", {
      path: join(E2E_DATA_DIR, "store.bin"),
    });
    if (storeRid == null) throw new Error("onboarding store is not loaded");
    originalOnboarding = await nativeState();
  });

  after(async () => {
    await openHomeWindow();
    if (originalOnboarding) await persistNativeState(originalOnboarding);
    await browser.execute((key: string) => localStorage.removeItem(key), LEARNING_STORAGE_KEY);
    await invokeOrThrow("plugin:event|emit", { event: "chat-deleted", payload: { id: SUMMARY_CHAT_ID } });
    rmSync(SUMMARY_CHAT_PATH, { force: true });
  });

  it("shows a live countdown for the native learning job", async () => {
    const startedAt = await openNativePhase("learning");
    const counter = await $('[data-testid="first-run-countdown"]');
    const before = await counter.getText();
    await browser.waitUntil(async () => (await counter.getText()) !== before, {
      timeout: t(10_000), timeoutMsg: "native learning countdown stayed frozen",
    });
    expect((await nativeState()).firstRunSummaryStartedAt).toBe(startedAt);
    await saveScreenshot("first-run-native-learning");
  });

  it("rehydrates native writing after renderer reload without arming another job", async () => {
    const startedAt = await openNativePhase("writing");
    await reloadAndWaitForHome();
    await browser.waitUntil(async () =>
      (await $(BANNER).getAttribute("data-phase").catch(() => null)) === "writing",
      { timeout: t(15_000), timeoutMsg: "native writing did not survive reload" },
    );
    const state = await nativeState();
    expect(state.firstRunSummaryStartedAt).toBe(startedAt);
    expect(state.firstRunSummaryPhase).toBe("writing");
    await saveScreenshot("first-run-native-writing-after-reload");
  });

  it("shows the native empty outcome across reload and allows dismissal", async () => {
    await openNativePhase("empty");
    expect(await $(BANNER).getText()).toContain("Screenpipe is ready");
    expect(await $('[data-testid="first-run-next-steps"]').isExisting()).toBe(false);
    await reloadAndWaitForHome();
    await $('[data-testid="first-run-setup-complete"]').waitForDisplayed({ timeout: t(15_000) });
    await $('[data-testid="first-run-setup-complete"]').click();
    await $(BANNER).waitForExist({ reverse: true, timeout: t(5_000) });
    // Observe another native poll: a completed empty result must stay quiet.
    await browser.pause(1_500);
    expect(await $(BANNER).isExisting()).toBe(false);
    expect((await nativeState()).firstRunSummaryPhase).toBe("empty");
    await saveScreenshot("first-run-native-empty-dismissed");
  });

  it("opens the native summary without inventing a user turn", async () => {
    writeSummaryConversation();
    await openNativePhase("ready");
    await $('[data-testid="first-run-open-summary"]').click();
    await browser.waitUntil(async () =>
      (await browser.execute(() => document.body.textContent ?? "")).includes(SUMMARY_TEXT),
      { timeout: t(20_000), timeoutMsg: "native summary did not render" },
    );
    expect(await $('[data-testid="chat-message-user"]').isExisting()).toBe(false);
    await $(BANNER).waitForExist({ reverse: true, timeout: t(5_000) });
    await saveScreenshot("first-run-native-summary-open");
    await reloadAndWaitForHome();
    await browser.pause(1_500);
    expect(await $(BANNER).isExisting()).toBe(false);
    expect((await nativeState()).firstRunSummaryChatId).toBe(SUMMARY_CHAT_ID);
  });

  it("arms a fresh native job from real setup completion", async () => {
    await invokeOrThrow("complete_onboarding");
    await openHomeWindow();
    const state = await nativeState();
    expect(state.isCompleted).toBe(true);
    expect(state.firstRunSummaryPhase).toBe("learning");
    expect(typeof state.firstRunSummaryStartedAt).toBe("string");
    await browser.waitUntil(async () =>
      (await $(BANNER).getAttribute("data-phase").catch(() => null)) === "learning",
      { timeout: t(20_000), timeoutMsg: "real completion did not reach Home" },
    );
    await saveScreenshot("first-run-native-real-completion");
  });
});
