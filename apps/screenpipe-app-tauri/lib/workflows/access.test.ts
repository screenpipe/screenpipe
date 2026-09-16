// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com
import { expect, it } from "vitest";
import { workflowAccess } from "./access";
const usage = (patch = {}) => ({ hosted_ai:{plan:"business"}, remaining:100, cost_limit_reached:false, ...patch } as any);
it("gates only discovery and distinguishes unknown access from an upgrade", () => {
  expect(workflowAccess(null).state).toBe("unavailable");
  expect(workflowAccess(usage({hosted_ai:{plan:"basic"}})).state).toBe("upgrade");
  expect(workflowAccess(usage()).state).toBe("ready");
  expect(workflowAccess(usage({hosted_ai:{plan:"business_ultra"}})).state).toBe("ready");
});
it("honors low-balance policy even when notification cooldown suppresses the toast", () => {
  expect(workflowAccess(usage({background_pipe_advisory:{reason:"background_pipe_allowance_low",should_notify:false}})).state).toBe("paused");
  expect(workflowAccess(usage({cost_limit_reached:null})).state).toBe("unavailable");
  expect(workflowAccess(usage({remaining:0})).state).toBe("paused");
});
it("does not promise a daily reset for an unknown cost allowance window", () => {
  expect(workflowAccess(usage({cost_limit_reached:true,resets_at:"2026-10-01T00:00:00Z"}))).toMatchObject({state:"paused",resetAt:undefined});
});
