// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com
// Opt-in: installed Pi/account, production prompt/tools, fictional recorder only.
// Run from apps/screenpipe-app-tauri: bun scripts/eval-workflow-assistant.ts
import { mkdtemp, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { ASSISTANT_TOOLS, buildAssistantPrompt } from "../lib/workflows/assistant-prompt";
import { LUNA_MODEL } from "../lib/workflows/luna";

const cli = process.env.PI_EVAL_CLI || join(homedir(), ".screenpipe/pi-agent/node_modules/@earendil-works/pi-coding-agent/dist/cli.js");
const skill = resolve("../../crates/screenpipe-core/assets/skills/screenpipe-api/SKILL.md");
const end = new Date(); end.setHours(0, 0, 0, 0);
const start = new Date(end); start.setDate(start.getDate() - 1);
// The recorder accepts these machine-local calendar boundaries as well as ISO.
function boundary(value: string | null): number {
  if (value === "yesterday") return start.getTime();
  if (value === "today") return end.getTime();
  return Date.parse(value || "");
}
let failures = 0;
for (const scenario of ["recap-with-catalog-attached", "recorder-unavailable"]) {
  const cwd = await mkdtemp(join(tmpdir(), "workflow-assistant-eval-"));
  const requests: { path: string; method: string; authenticated: boolean; start: string | null; end: string | null }[] = [];
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(request) {
    const url = new URL(request.url);
    const authenticated = request.headers.get("authorization") === "Bearer fictional-assistant-eval";
    requests.push({ path: url.pathname, method: request.method, authenticated, start: url.searchParams.get("start_time"), end: url.searchParams.get("end_time") });
    if (!authenticated) return Response.json({ error: "Authentication required" }, { status: 403 });
    if (scenario === "recorder-unavailable") return Response.json({ error: "Recorder temporarily unavailable" }, { status: 503 });
    if (url.pathname === "/activity-summary") return Response.json({
      data_status: "ok", query_status: "ok", start_time: start.toISOString(), end_time: end.toISOString(),
      total_active_minutes: 42,
      apps: [{ app_name: "Code", minutes: 42, windows: [{ window_name: "Harbor receipt matching", minutes: 42,
        key_texts: ["Fixed duplicate receipt matching in Harbor. Regression tests passed."] }] }],
      guidance: "Activity is available for this range.",
    });
    return Response.json({ data: [], pagination: { total: 0 }, data_status: "no_capture_in_range" });
  } });
  try {
    const base = `http://127.0.0.1:${server.port}`;
    const prompt = buildAssistantPrompt("What did I work on yesterday?", { key: "catalog", title: "Your workflows" }, []);
    const child = Bun.spawn([process.execPath, cli, "--provider", "screenpipe", "--model", LUNA_MODEL,
      "--mode", "json", "--no-session", "--no-extensions", "--no-skills", "--skill", skill,
      "--no-context-files", "--no-prompt-templates", "--tools", ASSISTANT_TOOLS.join(","),
      "--append-system-prompt", `This is a fictional-recorder evaluation. Use only ${base} for recorder calls, via SCREENPIPE_LOCAL_API_URL. Never contact port 3030, port 11435 or another recorder/service. Authentication is already in SCREENPIPE_LOCAL_API_KEY.`,
      "--print", prompt], { cwd, env: { ...process.env, SCREENPIPE_LOCAL_API_URL: base,
        SCREENPIPE_LOCAL_API_KEY: "fictional-assistant-eval", SCREENPIPE_PIPE_NAME: "",
        BASH_ENV: join(homedir(), ".screenpipe/pi-agent/bash-env.sh"),
        PI_CODING_AGENT_DIR: join(homedir(), ".screenpipe/pi-config") }, stdout: "pipe", stderr: "pipe" });
    const timeout = setTimeout(() => child.kill(), 120_000);
    const [stdout, stderr, exit] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    clearTimeout(timeout);
    const events = stdout.split("\n").flatMap(line => { try { return [JSON.parse(line)]; } catch { return []; } });
    const tools = events.filter(e => e.type === "tool_execution_end").map(e => e.toolName);
    const answer = events.filter(e => e.type === "message_end" && e.message?.role === "assistant").at(-1)?.message?.content?.filter((p: any) => p.type === "text").map((p: any) => p.text).join(" ") || "";
    const readHistory = requests.some(r => r.path === "/activity-summary" && r.authenticated &&
      Math.abs(boundary(r.start) - start.getTime()) < 60_000 &&
      Math.abs(boundary(r.end) - end.getTime()) < 60_000);
    const passed = exit === 0 && tools.includes("read") && tools.includes("bash") && readHistory &&
      requests.every(r => r.method === "GET") && (scenario === "recorder-unavailable"
        ? /unavailable|503|couldn.t (connect|retrieve|reach)|could not (connect|retrieve|reach)/i.test(answer)
        : /Harbor/i.test(answer) && /receipt/i.test(answer));
    console.log(JSON.stringify({ scenario, passed, exit, tools, requests, answer, stderrPresent: !!stderr.trim() }));
    if (!passed) failures++;
  } finally { server.stop(true); await rm(cwd, { recursive: true, force: true }); }
}
process.exit(failures ? 1 : 0);
