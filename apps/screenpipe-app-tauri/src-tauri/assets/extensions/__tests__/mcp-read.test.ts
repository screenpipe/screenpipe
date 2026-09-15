// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com
import { afterEach, expect, it, vi } from "vitest";
import bridge from "../mcp-bridge";
const signal = new AbortController().signal;
function setup(annotations?: Record<string, boolean>, enabled = true) {
  const tools = new Map<string, any>();
  bridge({ registerTool: (tool: any) => tools.set(tool.name, tool) } as any);
  const fetchMock = vi.fn(async (url: string, options?: RequestInit) => {
    if (options?.method === "POST") return new Response(JSON.stringify({ data: { content: [{ type: "text", text: "Recent planning notes" }] } }));
    if (url.endsWith("/tools")) return new Response(JSON.stringify({ data: { tools: [{ name: "search", annotations, inputSchema: { type: "object", properties: { query: { type: "string" } } } }] } }));
    return new Response(JSON.stringify({ data: [{ id: "work", name: "Work docs", enabled }] }));
  });
  vi.stubGlobal("fetch", fetchMock);
  return { tools, fetchMock };
}
afterEach(() => vi.unstubAllGlobals());
it("discovers schemas and reads through the existing MCP transport", async () => {
  const { tools, fetchMock } = setup({ readOnlyHint: true });
  const overview = await tools.get("sp_mcp_list_tools").execute("list", {}, signal);
  expect(overview.content[0].text).not.toContain('"inputSchema"');
  const listed = await tools.get("sp_mcp_list_tools").execute("list", { server_id: "work" }, signal);
  expect(listed.content[0].text).toContain('"inputSchema"');
  expect(listed.content[0].text).toContain('"readOnlyHint":true');
  const result = await tools.get("sp_mcp_read").execute("read", { server_id: "work", tool: "search", arguments: { query: "priorities" } }, signal);
  expect(result.content[0].text).toBe("Recent planning notes");
  expect(fetchMock).toHaveBeenCalledWith(expect.stringContaining("/work/call"), expect.objectContaining({ method: "POST", body: JSON.stringify({ tool: "search", arguments: { query: "priorities" } }) }));
});
it.each([undefined, { readOnlyHint: false }, { readOnlyHint: true, destructiveHint: true }])("refuses unverified or mutable capabilities: %j", async (annotations) => {
  const { tools, fetchMock } = setup(annotations);
  const result = await tools.get("sp_mcp_read").execute("read", { server_id: "work", tool: "search" }, signal);
  expect(result.isError).toBe(true);
  expect(fetchMock.mock.calls.some(([, options]) => options?.method === "POST")).toBe(false);
});
it("refuses disabled connections before invoking their tools", async () => {
  const { tools, fetchMock } = setup({ readOnlyHint: true }, false);
  expect((await tools.get("sp_mcp_read").execute("read", { server_id: "work", tool: "search" }, signal)).isError).toBe(true);
  expect(fetchMock).toHaveBeenCalledTimes(1);
});
