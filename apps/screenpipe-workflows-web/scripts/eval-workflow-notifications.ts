// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com
// Run against the MAIN app's browser-mock server. Native delivery is covered
// separately by notifications::* Rust tests; this never contacts a real recorder.
import { chromium } from "playwright";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import assert from "node:assert/strict";
import { fixtureWorkflowAnalysis } from "../../../packages/workflows-ui/src/fixture-platform";

const base = process.env.WORKFLOW_APP_URL || "http://127.0.0.1:1458";
const output = process.env.WORKFLOW_SCREENSHOTS || "/tmp/workflow-notification-screenshots";
await mkdir(output, { recursive: true });
const catalog = structuredClone(fixtureWorkflowAnalysis);
catalog.analysis.workflows.forEach((workflow, index) => { workflow.id = `wf-fixture-${index}`; });
const browser = await chromium.launch({ channel: "chrome", headless: true });
let pageForFailure: import("playwright").Page | undefined;
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  pageForFailure = page;
  page.setDefaultTimeout(15000);
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.stack || error.message));
  await page.addInitScript(data => localStorage.setItem("screenpipe:fictional-workflow-editor-preview", JSON.stringify(data)), catalog);
  await page.goto(`${base}/home?mode=workflows`);
  await page.getByText("Research synthesis", { exact: true }).waitFor({ timeout: 60000 });
  await page.getByRole("button", { name: "Do later", exact: true }).click({ timeout: 10000 });
  await page.getByRole("dialog").waitFor({ state: "hidden" });
  await page.getByRole("heading", { name: "Your workflows", exact: true }).waitFor();
  await page.addStyleTag({ content: "nextjs-portal { display: none; }" });
  const snap = async (name: string) => {
    await page.mouse.move(2, 2);
    await page.screenshot({ path: join(output, `${name}.png`), animations: "disabled" });
  };
  const emit = (event: string, payload: unknown) => page.evaluate(({ event, payload }) =>
    (window as any).__SCREENPIPE_WEB_DEV_EMIT__(event, payload), { event, payload });
  const navigate = (query: string) => emit("navigate", { url: `/home?mode=workflows&${query}` });
  await snap("catalog-idle");
  await emit("workflow-review-ready", ["wf-fixture-0"]);
  await page.getByText("Ready to review", { exact: true }).waitFor();
  assert.equal(await page.getByRole("heading", { name: "Your workflows" }).count(), 1);
  await snap("quiet-ready");
  await navigate("reviewRequest=batch-1&workflows=wf-fixture-0%2Cwf-fixture-4");
  await page.waitForFunction(() => [...document.querySelectorAll("span")].filter(e => e.textContent === "Ready to review").length === 2);
  await snap("batch-review");
  await navigate("reviewRequest=single-1&workflow=wf-fixture-4");
  const title = page.getByRole("textbox", { name: "Workflow title", exact: true });
  await title.waitFor();
  assert.equal(await title.inputValue(), "Research synthesis");
  await snap("review-destination");
  await page.getByRole("button", { name: "All workflows", exact: true }).click();
  await navigate("reviewRequest=single-1&workflow=wf-fixture-4");
  assert.equal(await page.getByRole("heading", { name: "Your workflows" }).count(), 1, "late retry must not hijack navigation");
  await navigate("reviewRequest=missing-1&workflow=wf-removed");
  await page.getByText("This workflow is no longer available. Your other workflows are shown below.").waitFor();
  await snap("unavailable-workflow");
  await page.setViewportSize({ width: 390, height: 844 });
  await navigate("reviewRequest=batch-small&workflows=wf-fixture-0%2Cwf-fixture-4");
  await page.getByText("This workflow is no longer available. Your other workflows are shown below.").waitFor({ state: "hidden" });
  await page.getByText("Ready to review", { exact: true }).first().waitFor();
  assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), "no horizontal overflow");
  await snap("batch-small");
  await page.goto(`${base}/home?section=home&mode=workflows&reviewRequest=cold-start&workflow=wf-fixture-4`);
  await page.getByRole("button", { name: "Do later", exact: true }).click({ timeout: 10000 });
  await page.getByRole("dialog").waitFor({ state: "hidden" });
  await page.getByRole("textbox", { name: "Workflow title", exact: true }).waitFor({ timeout: 60000 });
  assert.equal(await page.getByRole("textbox", { name: "Workflow title", exact: true }).inputValue(), "Research synthesis", "cold-start destination survives without any navigation event");
  const panel = await browser.newPage({ viewport: { width: 340, height: 380 }, deviceScaleFactor: 2 });
  panel.on("pageerror", error => errors.push(error.stack || error.message));
  await panel.goto(`${base}/notification-panel`);
  await panel.waitForFunction(() => Boolean((window as any).__SCREENPIPE_WEB_DEV_EMIT__));
  await panel.addStyleTag({ content: "nextjs-portal { display: none; }" });
  const payload = {
    id: "workflow-review:wf-fixture-4:3", type: "pipe", pipe_name: "workflow-review",
    title: "A workflow is ready to review", body: "Review the mapped steps, add feedback, or create an SOP.",
    actions: [{ type: "deeplink", label: "Review workflow", url: "screenpipe://workflows?workflow=wf-fixture-4&source=notification", primary: true }],
    autoDismissMs: 0, priority: "normal",
  };
  // Wait for the real panel's event listener, not a fixed animation delay.
  for (let attempt = 0; attempt < 20; attempt++) {
    await panel.evaluate(payload => (window as any).__SCREENPIPE_WEB_DEV_EMIT__("notification-panel-update", JSON.stringify(payload)), payload);
    if (await panel.getByText(payload.title, { exact: true }).isVisible()) break;
    await panel.waitForTimeout(100);
  }
  await panel.getByText(payload.title, { exact: true }).waitFor();
  await panel.locator('[class="group/notif"]').screenshot({ path: join(output, "after-notification.png"), animations: "disabled" });
  assert.deepEqual(errors, []);
  console.log("Passed: quiet readiness, batch targets, exact destination, late retry, deleted workflow, narrow layout, cold-start URL and notification panel; fictional data only.");
} catch (error) {
  await pageForFailure?.screenshot({ path: join(output, "failure.png") });
  console.error(await pageForFailure?.locator("body").innerText());
  throw error;
} finally { await browser.close(); }
