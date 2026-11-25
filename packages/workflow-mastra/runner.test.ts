// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com

import { expect, test } from "bun:test";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const runner = join(import.meta.dir, "runner.ts");
const task = "workflow-review";

test("streams a review, rereads evidence, recovers from a revision conflict, and finishes", async () => {
  const root = await mkdtemp(join(tmpdir(), "workflow-mastra-test-"));
  const cwd = join(root, task);
  await mkdir(cwd);

  const requests: string[] = [];
  const writes: Record<string, unknown>[] = [];
  let revision = 1;
  let reads = 0;
  let published = false;
  let complete = false;
  const recorder = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const { pathname } = new URL(request.url);
      requests.push(`${request.method} ${pathname}`);
      if (request.headers.get("authorization") !== "Bearer fixture-workspace") {
        return Response.json({ error: "Missing task token" }, { status: 401 });
      }
      if (pathname === "/search") {
        reads++;
        return Response.json({ text: "A".repeat(9_000), tail: "The user verified the invoice total." });
      }
      if (pathname === "/workflows/context") {
        return Response.json({ workflows: [], outputContract: {} });
      }
      if (pathname === "/workflows/workspace" && request.method === "GET") {
        return Response.json({
          workspace: { revision, cycle: { status: complete ? "complete" : "running" }, drafts: {} },
          catalogRevision: revision,
          canFinish: published,
        });
      }
      if (pathname === "/workflows/workspace" && request.method === "POST") {
        const write = await request.json();
        writes.push(write);
        if (write.task !== task || write.expected_revision !== revision || write.catalog_revision !== revision) {
          return Response.json({ error: "Wrong task or revision" }, { status: 409 });
        }
        if (write.action === "publish" && revision === 1) {
          revision++;
          return Response.json({ error: "Workspace changed. Read context again." }, { status: 409 });
        }
        if (write.action === "publish") published = reads === 1;
        if (write.action === "finish") complete = published;
        return Response.json({ saved: true, revision: ++revision });
      }
      return Response.json({ error: "Unexpected endpoint" }, { status: 404 });
    },
  });
  let step = 0;
  const publish = (at: number) => ({ action: "publish", draft_id: "invoice", expected_revision: at, catalog_revision: at, note: "Verified the invoice total" });
  const actions = [
    ["workflow_workspace", { action: "context" }],
    ["recorder_read", { source: "search", from: "2026-11-24T00:00:00Z", limit: 1 }],
    ["read_snapshot", {}],
    ["workflow_workspace", publish(1)],
    ["workflow_workspace", { action: "context" }],
    ["workflow_workspace", publish(2)],
    ["workflow_workspace", { action: "finish", expected_revision: 3, catalog_revision: 3, note: "Finished review" }],
  ] as const;
  const model = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      expect(new URL(request.url).pathname).toBe("/v1/chat/completions");
      expect(request.headers.get("authorization")).toBeNull();
      const body = await request.json();
      expect(body.model).toBe("fixture-model");
      expect(body.reasoning_effort).toBe("low");
      expect(body.tools.map((tool: any) => tool.function.name).sort()).toEqual([
        "read_snapshot", "recorder_read", "workflow_workspace",
      ]);
      const lastTool = body.messages.findLast((message: any) => message.role === "tool");
      const lastContent = JSON.stringify(lastTool?.content ?? "");
      let delta: Record<string, unknown> = { content: "Review completed." };
      if (step < actions.length) {
        const [name, input] = actions[step];
        let args: Record<string, unknown> = input;
        if (name === "read_snapshot") {
          const id = lastContent.match(/[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}/)?.[0];
          expect(id).toBeDefined();
          args = { snapshotId: id, offset: 8_000 };
        }
        if (step === 3) expect(lastContent).toContain("The user verified the invoice total.");
        if (step === 4) expect(lastContent).toContain("Workspace changed");
        delta = { tool_calls: [{ index: 0, id: `call_${step}`, type: "function", function: { name, arguments: JSON.stringify(args) } }] };
      }
      const finishReason = step++ < actions.length ? "tool_calls" : "stop";
      const chunk = (choice: Record<string, unknown>) => `data: ${JSON.stringify({
        id: "fixture", model: "fixture-model", object: "chat.completion.chunk", created: 0, choices: [{ index: 0, ...choice }],
      })}\n\n`;
      return new Response(chunk({ delta: { role: "assistant", ...delta }, finish_reason: null }) +
        chunk({ delta: {}, finish_reason: finishReason }) + "data: [DONE]\n\n", {
        headers: { "Content-Type": "text/event-stream" },
      });
    },
  });

  try {
    await Bun.write(join(cwd, ".screenpipe-permissions.json"), JSON.stringify({
      api_base: recorder.url.origin, pipe_name: task, pipe_token: "fixture-workspace",
    }));
    const child = Bun.spawn([process.execPath, "--no-install", "--no-env-file", runner], {
      cwd,
      env: { SCREENPIPE_MASTRA_MODEL_URL: `${model.url.origin}/v1` },
      stdin: new Blob([JSON.stringify({ task, model: "fixture-model", thinkingLevel: "low", instructions: "Review the invoice", prompt: "Review now" })]),
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr, status] = await Promise.all([child.stdout.text(), child.stderr.text(), child.exited]);
    expect(stderr).toBe("");
    expect(status).toBe(0);
    expect(stdout).toContain('"type":"message_update"');
    expect(stdout).toContain('"type":"agent_end"');
    expect(stdout).toContain('"isError":true');
    expect(stdout).not.toContain("fixture-workspace");
    expect(stdout).not.toContain("The user verified the invoice total.");
    expect(requests.indexOf("GET /search")).toBeLessThan(requests.indexOf("POST /workflows/workspace"));
    expect(writes.map(write => [write.action, write.expected_revision])).toEqual([
      ["publish", 1], ["publish", 2], ["finish", 3],
    ]);
    expect(complete).toBe(true);
  } finally {
    recorder.stop(true);
    model.stop(true);
    await rm(root, { recursive: true, force: true });
  }
}, 15_000);

test("rejects a hosted model endpoint before sending a prompt", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "workflow-mastra-url-"));
  try {
    await Bun.write(join(cwd, ".screenpipe-permissions.json"), JSON.stringify({
      api_base: "http://127.0.0.1:3030", pipe_name: task, pipe_token: "fixture-workspace",
    }));
    const child = Bun.spawn([process.execPath, "--no-install", "--no-env-file", runner], {
      cwd,
      env: { SCREENPIPE_MASTRA_MODEL_URL: "https://example.com/v1" },
      stdin: new Blob([JSON.stringify({ task, model: "fixture-model", thinkingLevel: "low", instructions: "Review", prompt: "private capture" })]),
      stderr: "pipe",
    });
    expect(await child.exited).toBe(1);
    expect(await child.stderr.text()).toContain("requires a plain HTTP loopback URL");
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});
