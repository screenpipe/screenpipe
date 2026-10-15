// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com
import { beforeEach, expect, it, vi } from "vitest";
const mock = vi.hoisted(() => ({ fetch: vi.fn() }));
vi.mock("@/lib/api", () => ({ localFetch: mock.fetch }));
import { setTeamSharing } from "./team-sharing";
beforeEach(() => { mock.fetch.mockReset().mockResolvedValue(new Response("{}", { status: 200 })); });
it("persists opt-in before enabling the scheduler", async () => {
  mock.fetch.mockImplementation(async () => new Response("{}"));
  await setTeamSharing(true, { account_id: "a", license_id: "team" });
  expect(mock.fetch.mock.calls.map(call => call[0])).toEqual(["/pipes/bundled/workflow-share/install", "/workflows/team-sharing", "/pipes/workflow-share/enable"]);
  expect(JSON.parse(mock.fetch.mock.calls[1][1].body)).toEqual({ action: "configure", enabled: true, account_id: "a", license_id: "team" });
});
it("revokes consent first even when the scheduler cannot be stopped", async () => {
  mock.fetch.mockImplementation(async (path: string) => new Response(path.startsWith("/pipes") ? "failure" : "{}", { status: path.startsWith("/pipes") ? 503 : 200 }));
  await expect(setTeamSharing(false)).rejects.toThrow("Sharing is off");
  expect(mock.fetch.mock.calls[0][0]).toBe("/workflows/team-sharing");
  expect(JSON.parse(mock.fetch.mock.calls[0][1].body)).toEqual({ action: "configure", enabled: false });
});
it("rolls back consent when scheduler enable fails", async () => {
  mock.fetch.mockImplementation(async (path: string) => new Response(path.endsWith("/enable") ? '{"error":"unavailable"}' : "{}", { status: path.endsWith("/enable") ? 503 : 200 }));
  await expect(setTeamSharing(true, { account_id: "a", license_id: "team" })).rejects.toThrow("unavailable");
  expect(JSON.parse(mock.fetch.mock.calls.at(-1)![1].body)).toEqual({ action: "configure", enabled: false });
});
it("does not install a missing task to disable sharing", async () => {
  mock.fetch.mockImplementation(async (path: string) => new Response("{}", { status: path.startsWith("/pipes") ? 404 : 200 }));
  await setTeamSharing(false);
  expect(mock.fetch.mock.calls).toHaveLength(2);
});
