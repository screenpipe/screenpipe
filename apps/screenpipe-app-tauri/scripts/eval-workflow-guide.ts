// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com
// Real configured Pi provider, fictional evidence only. This checks the generation
// contract, not native IPC or retrieval: all tools are disabled for this eval.
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";
import {
  guidePrompt,
  parseGuide,
} from "../../../packages/workflows-ui/src/guide";
import type { WorkflowMap } from "../../../packages/workflows-ui/src/model";
import { LUNA_MODEL } from "../lib/workflows/luna";
const workflow = {
  id: "fictional-research",
  revision: 2,
  title: "Research review",
  summary: "Collect sources and compare findings.",
  stages: [
    {
      title: "Collect sources",
      description:
        "Open the Research Brief document. Add source links to its Sources section. The evidence does not identify a required account or review owner.",
    },
    {
      title: "Compare findings",
      description:
        "Read each source and record a claim beside its supporting link. Flag contradictory sources. The evidence does not show how the final review is approved.",
    },
  ],
} as unknown as WorkflowMap;
const directory = await mkdtemp(join(tmpdir(), "workflow-guide-eval-"));
try {
  const child = Bun.spawn(
    [
      process.execPath,
      join(
        homedir(),
        ".screenpipe/pi-agent/node_modules/@earendil-works/pi-coding-agent/dist/cli.js",
      ),
      "--provider",
      "screenpipe",
      "--model",
      LUNA_MODEL,
      "--mode",
      "json",
      "--no-session",
      "--no-tools",
      "--no-extensions",
      "--no-skills",
      "--no-context-files",
      "--no-prompt-templates",
      "--print",
      guidePrompt(workflow),
    ],
    {
      cwd: directory,
      env: {
        ...process.env,
        PI_CODING_AGENT_DIR: join(homedir(), ".screenpipe/pi-config"),
      },
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  const timeout = setTimeout(() => child.kill(), 120000);
  const [stdout, exit] = await Promise.all([
    new Response(child.stdout).text(),
    child.exited,
  ]);
  clearTimeout(timeout);
  if (exit !== 0)
    throw new Error(`Guide eval exited ${exit}; no guide was verified.`);
  const events = stdout.split("\n").flatMap((line) => {
    try {
      return [JSON.parse(line)];
    } catch {
      return [];
    }
  });
  const messages =
    events.filter((e) => e.type === "agent_end").at(-1)?.messages || [];
  const answer = messages.filter((m: any) => m.role === "assistant").at(-1);
  const text =
    answer?.content
      ?.filter((c: any) => c.type === "text")
      .map((c: any) => c.text)
      .join("") || "";
  const guide = parseGuide(
    JSON.parse(
      text
        .trim()
        .replace(/^```(?:json)?\s*/, "")
        .replace(/\s*```$/, ""),
    ),
    workflow,
  );
  if (!guide.questions.length)
    throw new Error(
      "Missing review owner/approval was not surfaced as a question",
    );
  if (guide.steps.some((s) => s.includeImage))
    throw new Error("Guide invented available screenshots");
  if (/https?:\/\//.test(JSON.stringify(guide)))
    throw new Error("Guide invented a URL");
  console.log(
    JSON.stringify({
      passed: true,
      provider: "screenpipe",
      model: LUNA_MODEL,
      steps: guide.steps.length,
      questions: guide.questions.length,
      tools: "disabled",
      evidence: "fictional",
    }),
  );
} finally {
  await rm(directory, { recursive: true, force: true });
}
