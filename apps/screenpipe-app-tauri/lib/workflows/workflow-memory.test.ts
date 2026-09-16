// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com
import { afterEach, expect, it, vi } from "vitest";
import { memoryPage, readHistoryJson } from "@screenpipe-ext/workflow-memory";
afterEach(() => { vi.unstubAllGlobals(); });

it("serializes parallel history requests and keeps the queue usable after failure", async () => {
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const fetch = vi.fn().mockImplementationOnce(async () => { await gate; return Response.json({error:"failed"},{status:500}); })
    .mockResolvedValue(Response.json({data:[]}));
  vi.stubGlobal("fetch",fetch);
  const first = readHistoryJson("http://localhost/search",{});
  const failure = expect(first).rejects.toThrow("failed");
  const second = readHistoryJson("http://localhost/meetings",{});
  await Promise.resolve();
  expect(fetch).toHaveBeenCalledTimes(1);
  release();
  await failure;
  await expect(second).resolves.toEqual({data:[]});
  expect(fetch).toHaveBeenCalledTimes(2);
});

it("retries explicit busy responses within a bounded budget", async () => {
  const fetch = vi.fn().mockImplementation(async () => Response.json({error:"recording takes priority",retry_after_ms:1},{status:503}));
  vi.stubGlobal("fetch",fetch);
  await expect(readHistoryJson("http://localhost/search",{})).rejects.toThrow("recording takes priority");
  expect(fetch).toHaveBeenCalledTimes(3);
});

it("does not start an aborted queued request", async () => {
  const controller = new AbortController(); controller.abort();
  const fetch = vi.fn(); vi.stubGlobal("fetch",fetch);
  await expect(readHistoryJson("http://localhost/search",{},controller.signal)).rejects.toThrow();
  expect(fetch).not.toHaveBeenCalled();
});

it("returns valid bounded pages without skipping records removed by the text budget", () => {
  const records = Array.from({length:30},(_,id)=>({id,text:"x".repeat(4000),image_base64:"private-image"}));
  let offset = 0;
  const seen: number[] = [];
  while (offset < records.length) {
    const page = memoryPage({data:records.slice(offset),pagination:{offset,total:records.length}},{});
    const result = JSON.parse(page.text);
    expect(result.data.length).toBe(page.count);
    expect(page.text.length).toBeLessThan(16000);
    expect(page.text).not.toContain("private-image");
    seen.push(...result.data.map((row:any)=>row.id));
    offset = result.pagination.next_offset;
    expect(result.pagination.has_more).toBe(offset < records.length);
  }
  expect(seen).toEqual(records.map(row=>row.id));
});
