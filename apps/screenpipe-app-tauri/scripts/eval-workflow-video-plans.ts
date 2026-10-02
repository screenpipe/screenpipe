// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com
// Opt-in live eval. Input/output stay outside the repo. No workflow is saved or executed.
import { readFile, writeFile, mkdir, mkdtemp, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { guidePrompt, parseGuide } from "../../../packages/workflows-ui/src/guide";
import { guideVideoScenes } from "../../../packages/workflows-ui/src/guide-video";
const [input, output] = process.argv.slice(2);
if (!input || !output) throw new Error("Usage: bun scripts/eval-workflow-video-plans.ts PRIVATE_WORKFLOWS_JSON PRIVATE_OUTPUT_DIR");
const workflows = JSON.parse(await readFile(resolve(input), "utf8"));
if (!Array.isArray(workflows) || workflows.length > 12) throw new Error("Use at most 12 workflows per eval.");
await mkdir(output, { recursive: true, mode: 0o700 });
const results: object[] = [];
for (let i = 0; i < workflows.length; i++) {
  const workflow = workflows[i];
  const cwd = await mkdtemp(join(tmpdir(), "sop-video-eval-"));
  const started = Date.now();
  try {
    const child = Bun.spawn([process.execPath, join(homedir(), ".screenpipe/pi-agent/node_modules/@earendil-works/pi-coding-agent/dist/cli.js"),
      "--provider", "screenpipe", "--model", "auto", "--mode", "json", "--no-session", "--no-tools", "--no-extensions", "--no-skills", "--no-context-files", "--no-prompt-templates", "--print", guidePrompt(workflow)],
      { cwd, env: { ...process.env, PI_CODING_AGENT_DIR: join(homedir(), ".screenpipe/pi-config") }, stdout: "pipe", stderr: "pipe" });
    const timeout = setTimeout(() => child.kill(), 180000);
    const [stdout, exit] = await Promise.all([new Response(child.stdout).text(), child.exited, new Response(child.stderr).text()]);
    clearTimeout(timeout);
    if (exit !== 0) throw new Error(`SOP generation exited ${exit}`);
    const events = stdout.split("\n").flatMap(line => { try { return [JSON.parse(line)]; } catch { return []; } });
    const answer = events.filter(e => e.type === "agent_end").at(-1)?.messages?.filter((m: any) => m.role === "assistant").at(-1);
    const text = answer?.content?.filter((c: any) => c.type === "text").map((c: any) => c.text).join("") || "";
    const guide = parseGuide(JSON.parse(text.trim().replace(/^```(?:json)?\s*/, "").replace(/\s*```$/, "")), workflow);
    const scenes = guideVideoScenes(guide, workflow);
    const record = { case: i + 1, guide, scenes, workflowId: workflow.id };
    await writeFile(join(output, `case-${i + 1}.json`), JSON.stringify(record, null, 2), { mode: 0o600 });
    results.push({ case: i + 1, status: "passed", steps: guide.steps.length, sections: scenes.length, characters: scenes.reduce((n,s) => n + [...s.narration].length, 0), images: scenes.filter(s => s.image || s.imageFrameId).length, seconds: (Date.now()-started)/1000 });
  } catch (error) { results.push({ case: i + 1, status: "failed", error: (error as Error).message }); }
  finally { await rm(cwd, { recursive: true, force: true }); }
  console.log(JSON.stringify(results.at(-1)));
  await writeFile(join(output, "plan-results.json"), JSON.stringify(results, null, 2));
}
if (results.some((r: any) => r.status !== "passed")) process.exitCode = 1;
