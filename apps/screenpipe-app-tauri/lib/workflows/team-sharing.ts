// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com
import { localFetch } from "@/lib/api";
export type TeamSharingStatus = { enabled: boolean; account_id: string; license_id: string };
async function call(path: string, body?: unknown) {
  const response = await localFetch(path, {
    signal: AbortSignal.timeout(60_000),
    ...(body === undefined ? {} : { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }),
  });
  const value = await response.json();
  if (!response.ok || value.error) throw new Error(value.error || "Could not update team sharing.");
  return value;
}
export const loadTeamSharing = (): Promise<TeamSharingStatus> => call("/workflows/team-sharing");
export async function setTeamSharing(enabled: boolean, destination?: Pick<TeamSharingStatus, "account_id" | "license_id">) {
  if (enabled) {
    if (!destination?.account_id || !destination.license_id) throw new Error("Check your team workspace before enabling sharing.");
    // Install remains disabled. The owner grant is durable before scheduling.
    await call("/pipes/bundled/workflow-share/install", {});
    await call("/workflows/team-sharing", { action: "configure", enabled: true, ...destination });
    try { await call("/pipes/workflow-share/enable", { enabled: true }); }
    catch (error) {
      await call("/workflows/team-sharing", { action: "configure", enabled: false });
      throw error;
    }
  } else {
    // Refusal wins even if stopping the scheduler fails or the account signs out.
    await call("/workflows/team-sharing", { action: "configure", enabled: false });
    const response = await localFetch("/pipes/workflow-share/enable", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ enabled: false }), signal: AbortSignal.timeout(10_000) });
    if (!response.ok && response.status !== 404) throw new Error("Sharing is off. The scheduled task could not be disabled; retry to stop its checks.");
  }
}
export const teamSharing = { load: loadTeamSharing, set: setTeamSharing };
