// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com
import { describe, expect, it, vi } from "vitest";
import { fixturePersonalWorkProfile } from "@screenpipe/workflows-ui/fixture";
const run = vi.hoisted(() => vi.fn());
vi.mock("./agent-runner", () => ({ runWorkflowAgent: run }));
import { CONTEXT_TOOLS, fillWorkContext } from "./context";
const request = () => ({ documents: [{ name: "Notes", text: "I own support operations." }], website: "", profile: fixturePersonalWorkProfile, signal: new AbortController().signal, onField: vi.fn(), onActivity: vi.fn() });
it("applies only successful typed tool results, once, from the scoped harness", async () => {
  const req = request();
  run.mockImplementation(async ({ config, onEvent }) => {
    expect(config.allowedTools).toEqual(CONTEXT_TOOLS);
    const event = { type: "tool_execution_end", toolName: "fill_work_context", result: { content: [{ text: JSON.stringify({ field: "summary", value: "I own support operations." }) }] } };
    onEvent({ ...event, isError: true });
    onEvent({ ...event, toolName: "another_tool" });
    onEvent(event); onEvent(event);
  });
  await fillWorkContext(req);
  expect(req.onField).toHaveBeenCalledOnce();
  expect(req.onField).toHaveBeenCalledWith({ field: "summary", value: "I own support operations." });
});
it("enables public web search only for an explicit website and rejects invalid output", async () => {
  run.mockImplementation(async ({ config, prompt, onEvent }) => {
    expect(config.allowedTools).toEqual([...CONTEXT_TOOLS, "sp_web_search"]);
    expect(prompt).toContain("https://example.com");
    expect(prompt).not.toContain("secret-token");
    onEvent({ type: "tool_execution_end", toolName: "fill_work_context", result: { content: [{ text: '{"field":"visibility","value":"public"}' }] } });
  });
  await expect(fillWorkContext({ ...request(), website: "https://example.com/?token=secret-token" })).rejects.toThrow("Unknown context field");
});
it("does not treat a prose answer as a successful fill", async () => {
  run.mockResolvedValue("Filled everything.");
  await expect(fillWorkContext(request())).rejects.toThrow("No supported context");
});

it("discovers work context from memory, skills and connections with no website or uploads", async () => {
  run.mockImplementation(async ({ config, prompt, onEvent }) => {
    expect(config.allowedTools).toEqual(CONTEXT_TOOLS);
    expect(config.allowedTools).not.toEqual(expect.arrayContaining(["bash", "sp_mcp_call", "write"]));
    expect(prompt).toContain("search-content");
    expect(prompt).toContain("skill_manage");
    expect(prompt).toContain("sp_mcp_read");
    expect(prompt).toContain("No public web research.");
    onEvent({ type: "tool_execution_end", toolName: "fill_work_context", result: { content: [{ text: JSON.stringify({ field: "priorities", value: "Improve customer onboarding, based on the recent planning meeting." }) }] } });
  });
  const req = { ...request(), documents: [] };
  await fillWorkContext(req);
  expect(req.onField).toHaveBeenCalledWith(expect.objectContaining({ field: "priorities" }));
});
