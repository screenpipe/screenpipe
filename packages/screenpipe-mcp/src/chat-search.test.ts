// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com
import { expect, it, vi } from "vitest";
import { CHAT_SEARCH_TOOL, searchChats } from "./chat-search";

it("sends only bounded read arguments and preserves source attribution and partial coverage", async () => {
  const data = { results: [{ source: "codex", id: "thread-1", title: "Project", preview: "decision", updated_at: 42 }], warnings: ["older chats were not scanned"], coverage: "bounded_recent_chats", read_only: true };
  const api = vi.fn().mockResolvedValue(Response.json(data));
  const result = await searchChats({ query: "decision", sources: ["codex"], limit: 5 }, api);
  expect(api).toHaveBeenCalledWith("/chats/search", expect.objectContaining({ method: "POST", body: JSON.stringify({ query: "decision", sources: ["codex"], limit: 5 }) }));
  expect(JSON.parse(result.content[0].text)).toEqual(data);
  expect(CHAT_SEARCH_TOOL.annotations?.readOnlyHint).toBe(true);
});

it.each([{ limit: 0 }, { limit: 51 }, { limit: 1.5 }, { query: 2 }, { query: "x".repeat(1001) }, { sources: ["unknown"] }, { sources: "codex" }, { confirmed: true }, { message: "send this" }])("rejects invalid input before any request: %j", async args => {
  const api = vi.fn();
  await expect(searchChats(args, api)).rejects.toThrow();
  expect(api).not.toHaveBeenCalled();
});

it("lists recent chats with bounded defaults", async () => {
  const api = vi.fn().mockResolvedValue(Response.json({ results: [], warnings: [] }));
  await searchChats({}, api);
  expect(JSON.parse(api.mock.calls[0][1].body)).toEqual({ query: "", sources: [], limit: 10 });
});

it.each([401, 404, 503, 504])("does not turn HTTP %s into an empty result", async status => {
  await expect(searchChats({}, async () => new Response("{}", { status }))).rejects.toThrow(`HTTP ${status}`);
});

it("rejects a malformed successful response", async () => {
  await expect(searchChats({}, async () => Response.json({}))).rejects.toThrow("coverage is unknown");
});
