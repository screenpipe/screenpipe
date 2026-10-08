// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com
import { afterEach, expect, it, vi } from "vitest";
import { createCallObserver, currentMcpRequestId, observeSearchResult, observeMcpError, type CallObservation } from "./call-observation";
const tick = () => new Promise(resolve => setImmediate(resolve));
afterEach(() => vi.useRealTimers());
function fixture(send?: (p: CallObservation, s: AbortSignal) => Promise<unknown>, enabled = true) {
  const sent: CallObservation[] = [];
  const observe = createCallObserver({ tools: ["search-content"], transport: "stdio", client: () => "codex", enabled: () => enabled,
    send: send || (async p => { sent.push(p); }) });
  return { sent, observe };
}
it("isolates concurrent calls and keeps raw content out of diagnostics", async () => {
  const { sent, observe } = fixture();
  const results = await Promise.all([0, 2].map(count => observe("search-content", async () => {
    const id = currentMcpRequestId(); await tick(); expect(currentMcpRequestId()).toBe(id);
    observeSearchResult(count, count > 0); return {content:[{type:"text",text:"private query and answer"}]};
  })));
  await tick();
  expect(new Set(sent.map(p => p.request_id)).size).toBe(2);
  expect(sent.map(p => p.status)).toEqual(["empty", "ok"]);
  expect(results.map(r => r._meta?.["screenpipe/request_id"])).toEqual(sent.map(p => p.request_id));
  expect(JSON.stringify(sent)).not.toContain("private"); expect(currentMcpRequestId()).toBeUndefined();
});
it("records returned and thrown errors without their text or unknown tool names", async () => {
  const { sent, observe } = fixture();
  await observe("private-tool-name", async () => { observeMcpError({status:401}); return {isError:true,content:[]}; });
  await expect(observe("search-content", async () => { throw Object.assign(new Error("private"), {status:503}); })).rejects.toThrow("private");
  await tick();
  expect(sent.map(p => [p.tool, p.status, p.error_kind])).toEqual([["unknown","error","auth"],["search-content","error","backend"]]);
  expect(sent[0].result_count).toBeUndefined(); expect(JSON.stringify(sent)).not.toContain("private");
});
it("does no reporting when disabled and retains the tool result if reporting throws", async () => {
  const send = vi.fn().mockRejectedValue(new Error("offline"));
  await fixture(send, false).observe("search-content", async () => ({content:[]}));
  expect(send).not.toHaveBeenCalled();
  const result = await fixture(send).observe("search-content", async () => ({content:[{text:"answer"}]}));
  await tick(); expect(result.content[0].text).toBe("answer");
});
it("bounds outstanding reports, expires hung adapters, and reports the loss later", async () => {
  vi.useFakeTimers(); const sent: CallObservation[] = [];
  let hang = true;
  const {observe} = fixture(async p => {sent.push(p); if(hang) await new Promise(() => {});});
  for(let i=0;i<12;i++) await observe("search-content",async()=>({content:[]}));
  expect(sent).toHaveLength(8);
  await vi.advanceTimersByTimeAsync(1001); hang = false;
  await observe("search-content",async()=>({content:[]})); await vi.advanceTimersByTimeAsync(1);
  expect(sent).toHaveLength(9); expect(sent[8].dropped_reports).toBe(12);
});
