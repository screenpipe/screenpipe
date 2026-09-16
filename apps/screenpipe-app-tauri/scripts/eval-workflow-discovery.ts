// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com
// Opt-in: real installed Pi harness/account, fictional local recorder responses.
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir, homedir } from "node:os";
import { join, resolve } from "node:path";
const root = resolve("../..");
const assets = join(root, "crates/screenpipe-core/assets");
const prompt = (await Bun.file(join(assets, "pipes/workflow-discovery/pipe.md")).text()).replace(/^---[\s\S]*?---\s*/, "");
const contract = await Bun.file(join(assets, "pipes/workflow-discovery/output.md")).text();
const now = new Date().toISOString();
const at = new Date(Date.now() - 60_000).toISOString();
const earlier = new Date(Date.now() - 7 * 86_400_000).toISOString();
const source = { type: "OCR", content: { text_source: "accessibility", frame_id: 7, timestamp: at, app_name: "Browser", text: "Inbox preview: First candidate shortlist is ready. Please review the six candidates. No candidate review or decision is captured." } };
// Opaque white page: intentionally no visual support for a completed review.
const blank = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAoAAAAGQCAIAAACxkUZyAAAGKUlEQVR4nO3VMQEAMAyAsPo3vboYRxMFfMwDAL6bOgAALjJgAAgYMAAEDBgAAgYMAAEDBoCAAQNAwIABIGDAABAwYAAIGDAABAwYAAIGDAABAwaAgAEDQMCAASBgwAAQMGAACBgwAAQMGAACBgwAAQMGgIABA0DAgAEgYMAAEDBgAAgYMAAEDBgAAgYMAAEDBoCAAQNAwIABIGDAABAwYAAIGDAABAwYAAIGDAABAwaAgAEDQMCAASBgwAAQMGAACBgwAAQMGAACBgwAAQMGgIABA0DAgAEgYMAAEDBgAAgYMAAEDBgAAgYMAAEDBoCAAQNAwIABIGDAABAwYAAIGDAABAwYAAIGDAABAwaAgAEDQMCAASBgwAAQMGAACBgwAAQMGAACBgwAAQMGgIABA0DAgAEgYMAAEDBgAAgYMAAEDBgAAgYMAAEDBoCAAQNAwIABIGDAABAwYAAIGDAABAwYAAIGDAABAwaAgAEDQMCAASBgwAAQMGAACBgwAAQMGAACBgwAAQMGgIABA0DAgAEgYMAAEDBgAAgYMAAEDBgAAgYMAAEDBoCAAQNAwIABIGDAABAwYAAIGDAABAwYAAIGDAABAwaAgAEDQMCAASBgwAAQMGAACBgwAAQMGAACBgwAAQMGgIABA0DAgAEgYMAAEDBgAAgYMAAEDBgAAgYMAAEDBoCAAQNAwIABIGDAABAwYAAIGDAABAwYAAIGDAABAwaAgAEDQMCAASBgwAAQMGAACBgwAAQMGAACBgwAAQMGgIABA0DAgAEgYMAAEDBgAAgYMAAEDBgAAgYMAAEDBoCAAQNAwIABIGDAABAwYAAIGDAABAwYAAIGDAABAwaAgAEDQMCAASBgwAAQMGAACBgwAAQMGAACBgwAAQMGgIABA0DAgAEgYMAAEDBgAAgYMAAEDBgAAgYMAAEDBoCAAQNAwIABIGDAABAwYAAIGDAABAwYAAIGDAABAwaAgAEDQMCAASBgwAAQMGAACBgwAAQMGAACBgwAAQMGgIABA0DAgAEgYMAAEDBgAAgYMAAEDBgAAgYMAAEDBoCAAQNAwIABIGDAABAwYAAIGDAABAwYAAIGDAABAwaAgAEDQMCAASBgwAAQMGAACBgwAAQMGAACBgwAAQMGgIABA0DAgAEgYMAAEDBgAAgYMAAEDBgAAgYMAAEDBoCAAQNAwIABIGDAABAwYAAIGDAABAwYAAIGDAABAwaAgAEDQMCAASBgwAAQMGAACBgwAAQMGAACBgwAAQMGgIABA0DAgAEgYMAAEDBgAAgYMAAEDBgAAgYMAAEDBoCAAQNAwIABIGDAABAwYAAIGDAABAwYAAIGDAABAwaAgAEDQMCAASBgwAAQMGAACBgwAAQMGAACBgwAAQMGgIABA0DAgAEgYMAAEDBgAAgYMAAEDBgAAgYMAAEDBoCAAQNAwIABIGDAABAwYAAIGDAABAwYAAIGDAABAwaAgAEDQMCAASBgwAAQMGAACBgwAAQMGAACBgwAAQMGgIABA0DAgAEgYMAAEDBgAAgYMAAEDBgAAgYMAAEDBoCAAQNAwIABIGDAABAwYAAIGDAABAwYAAIGDAABAwaAgAEDQMCAASBgwAAQMGAACBgwAAQMGAACBgwAAQMGgIABA0DAgAEgYMAAEDBgAAgYMAAEDBgAAgYMAAEDBoCAAQNAwIABIGDAABAwYAAIGDAABAwYAAIGDAABAwaAgAEDQMCAASBgwAAQMGAACBgwAAQMGAACBgwAAQMGgIABA0DAgAEgYMAAEDBgAAgYMAAEDBgAAgYMAAEDBoCAAQNAwIABIGDAABAwYAAIGDAABAwYAAIGDAABAwaAgAEDQMCAASBgwAAQMGAACBgwAAQMGAACBgwAAQMGgIABA0DAgAEgYMAAEDBgAAgYMAAEDBgAAgYMAAEDBoCAAQNAwIABIGDAABAwYAAIGDAABAwYAAIGDAABAwaAgAEDQMCAASBgwAAQMGAACBgwAAQMGAACBgwAAQMGgIABA0DAgAEgYMAAEDBgAAgYMAAEDBgAAgYMAAEDBoCAAQNAwIABIGDAABAwYAAIGDAABAwYAAIGDAABAwaAgAEDQGAB1fb3FRZMqfgAAAAASUVORK5CYII=", "base64");
let failures = 0;
for (const scenario of ["blank-request-is-not-completed-work", "updates-existing-identity", "source-failure-does-not-checkpoint", "rejected-save-is-repaired"]) {
  const directory = await mkdtemp(join(tmpdir(), "workflow-discovery-eval-"));
  const commits: any[] = []; const routes: string[] = [];
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    if (request.headers.get("authorization") !== "Bearer fictional-eval-token") return new Response("Unauthorized", { status: 401 });
    const path = new URL(request.url).pathname; routes.push(path);
    if (path === "/workflows/pipeline") return Response.json({ stage:4, ready:true, revision:4, inputRevision:4, checkedThrough:now, input:{ items:scenario === "source-failure-does-not-checkpoint" ? [{title:"Save vendor receipts",trigger:"A vendor receipt arrives",outcome:"Receipt saved",screenshotFrameId:7,sources:[{frameId:7,timestamp:at,app:"Receipts"}],steps:["Open receipt","Enter invoice details","Save receipt"]}] : scenario === "updates-existing-identity" ? [{workflowId:"wf-existing",title:"Save vendor receipts",trigger:"A vendor receipt arrives",outcome:"Receipt saved",sources:[{timestamp:at,app:"Receipts",quote:"Receipt saved with vendor ExampleCo and invoice INV-123."}],steps:["Open the receipt attachment","Enter vendor and invoice number","Save receipt"]}] : [{title:"Review candidate request", screenshotFrameId:7, sources:[source]}] }});
    if (path === "/workflows/context") return Response.json({ revision: 3, now, historyStart: earlier, checkedThrough: earlier, profile: null, workflows: scenario === "updates-existing-identity" ? [{ id: "wf-existing", title: "Save vendor receipts", trigger: "A vendor receipt arrives", outcome: "A receipt is stored with its vendor and invoice number", userCorrection: "Keep the invoice number.", stages: [] }] : [], outputContract: contract });
    if (path === "/workflows/catalog") { const body = await request.json(); commits.push(body); if (scenario === "rejected-save-is-repaired" && commits.length === 1) return Response.json({ error: "Source verification rejected this proposal. Inspect the source and repair it, or submit an empty update if no supported changes remain." }, { status: 422 }); return Response.json({ revision: 4, changes: { created: body.workflows.length, updated: 0 }, checkedThrough: now }); }
    if (scenario === "source-failure-does-not-checkpoint") return Response.json({ error: "Recorder unavailable" }, { status: 503 });
    if (path === "/activity-summary") return Response.json({ total_frames: 1, apps: [{ app_name: "Browser", frame_count: 1 }], start_time: earlier, end_time: now });
    if (path === "/search") return Response.json({ data: scenario === "updates-existing-identity" ? [at, new Date(Date.now() - 86_400_000).toISOString()].map(timestamp => ({type: "OCR", content: { text_source: "accessibility", timestamp, app_name: "Receipts", text: "New vendor receipt. Open the receipt attachment. Enter vendor ExampleCo and invoice number INV-123. Click Save receipt. Receipt saved with vendor ExampleCo and invoice INV-123." }})) : [source], pagination: { total: 1, limit: 30, offset: 0 } });
    if (path === "/meetings") return Response.json({ data: [], pagination: { total: 0 } });
    if (path.endsWith("/thumbnail")) return new Response(blank, { headers: { "Content-Type": "image/png" } });
    if (path.endsWith("/metadata")) return Response.json({ frame_id: 7, timestamp: at });
    if (path.endsWith("/context")) return Response.json({ frames: [source.content] });
    return new Response("Not found", { status: 404 });
  } });
  try {
    await writeFile(join(directory, ".screenpipe-permissions.json"), JSON.stringify({ pipe_token: "fictional-eval-token", api_base: `http://127.0.0.1:${server.port}` }));
    const cli = process.env.PI_EVAL_CLI || join(homedir(), ".screenpipe/pi-agent/node_modules/@earendil-works/pi-coding-agent/dist/cli.js");
    const child = Bun.spawn([process.execPath, cli, "--provider", "screenpipe", "--model", "auto", "--mode", "json", "--no-session", "--append-system-prompt", `Use only the fictional recorder at http://127.0.0.1:${server.port} for this evaluation, via SCREENPIPE_LOCAL_API_URL. Never contact port 3030 or any other recorder.`, "--no-extensions", "--no-skills", "--skill", join(assets, "skills/screenpipe-api/SKILL.md"), "--no-context-files", "--no-prompt-templates", "--extension", join(assets, "extensions/workflow-catalog.ts"), "--print", prompt], { cwd: directory, env: { ...process.env, SCREENPIPE_LOCAL_API_URL: `http://127.0.0.1:${server.port}`, SCREENPIPE_LOCAL_API_KEY: "fictional-eval-token", SCREENPIPE_PIPE_NAME: "workflow-discovery", BASH_ENV:join(homedir(),".screenpipe/pi-agent/bash-env.sh"),PI_CODING_AGENT_DIR: join(homedir(), ".screenpipe/pi-config") }, stdout: "pipe", stderr: "pipe" });
    const timeout = setTimeout(() => child.kill(), 150_000);
    const [stdout, stderr, exit] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    clearTimeout(timeout);
    const tools = stdout.split("\n").flatMap(line => { try { const e = JSON.parse(line); return e.type === "tool_execution_end" ? [e.toolName] : []; } catch { return []; } });
    const passed = exit === (scenario === "source-failure-does-not-checkpoint" ? 1 : 0) && routes.includes("/workflows/context") && (scenario.startsWith("blank")
      ? commits.length === 1 && commits[0].workflows.length === 0
      : scenario === "updates-existing-identity" ? commits.some(c => c.workflows.some((w: any) => w.id === "wf-existing" && w.stages?.some((s: any) => s.procedure?.length)))
      : scenario === "rejected-save-is-repaired" ? commits.length >= 2 && commits.at(-1).workflows.length === 0
      : routes.length > 1 && commits.length === 0 && stderr.includes("missing_output"));
    console.log(JSON.stringify({ scenario, passed, exit, tools, commits: commits.length, stderrPresent: Boolean(stderr.trim()) }));
    if (!passed) { failures++; console.error(stdout.slice(-4500), stderr.slice(-1000)); }
  } finally { server.stop(true); await rm(directory, { recursive: true, force: true }); }
}
process.exit(failures ? 1 : 0);
