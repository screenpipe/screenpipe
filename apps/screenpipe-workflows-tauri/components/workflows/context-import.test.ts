// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com
import { expect, it, vi } from "vitest";
import { zipSync, strToU8 } from "fflate";
import { importContextFiles } from "@screenpipe/workflows-ui/context-import";
import contextTool, { mergeContextUpdate, parseContextUpdate } from "@screenpipe/workflows-ui/context";
import { fixturePersonalWorkProfile } from "@screenpipe/workflows-ui/fixture";
function file(name: string, bytes: Uint8Array): File { return { name, size: bytes.length, arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) } as File; }
it("reads supported ZIP entries locally, with a visible notice for skipped files", async () => {
  const result = await importContextFiles([file("notes.zip", zipSync({ "work.md": strToU8("I own support."), "image.png": new Uint8Array([0]) }))]);
  expect(result.sources).toEqual([{ name: "notes.zip / work.md", text: "I own support." }]);
  expect(result.warnings).toHaveLength(1);
});
it("rejects unsafe archive paths and expansion beyond its actual byte budget", async () => {
  await expect(importContextFiles([file("bad.zip", zipSync({ "../notes.md": strToU8("text") }))])).rejects.toThrow("unsafe");
  await expect(importContextFiles([file("large.zip", zipSync({ "notes.md": new Uint8Array(21 * 1024 * 1024) }))])).rejects.toThrow("limit");
});
it("rejects binary and oversized text without silently truncating", async () => {
  await expect(importContextFiles([file("binary.txt", new Uint8Array([0,1]))])).rejects.toThrow("text document");
  await expect(importContextFiles([file("long.md", strToU8("x".repeat(20001)))])).rejects.toThrow("20,000");
});
it("keeps a user edit made after the run began", () => {
  const base = fixturePersonalWorkProfile;
  expect(mergeContextUpdate(base, { ...base, summary: "My correction" }, { field: "summary", value: "AI suggestion" })).toBeNull();
  expect(mergeContextUpdate(base, base, { field: "company", value: "Example company" })?.company).toBe("Example company");
});
it("the real tool returns typed field updates and cannot modify visibility or hourly value", async () => {
  let tool: any;
  contextTool({ on: vi.fn(), registerTool: (registered) => { tool = registered; } });
  const result = await tool.execute("call", { field: "summary", value: "I lead support." });
  expect(parseContextUpdate(JSON.parse(result.content[0].text))).toEqual({ field: "summary", value: "I lead support." });
  await expect(tool.execute("call", { field: "visibility", value: "public" })).rejects.toThrow();
  await expect(tool.execute("call", { field: "hourlyValue", value: "1000" })).rejects.toThrow();
});

it("Context blocks writes through shared profile and skill tools", () => {
  let guard: any;
  contextTool({ on: (_event, handler) => { guard = handler; }, registerTool: vi.fn() });
  for (const [toolName, action] of [["user_profile", "save"], ["user_profile", "delete"], ["skill_manage", "create"], ["skill_manage", "patch"]]) {
    expect(guard({ toolName, input: { action, confirmed: true } })).toMatchObject({ block: true });
  }
  for (const [toolName, action] of [["user_profile", "list"], ["skill_manage", "list"], ["skill_manage", "read"]]) {
    expect(guard({ toolName, input: { action } })).toBeUndefined();
  }
});
