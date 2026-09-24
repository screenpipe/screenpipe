// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com
import { PROD_WEB_BASE, screenpipeWebUrl } from "@/lib/web-url";
import { commands } from "@/lib/utils/tauri";

export const SHARING_NOTICE_VERSION = "2026-09-23";
const endpoint = screenpipeWebUrl(`/api/trajectories?noticeVersion=${SHARING_NOTICE_VERSION}`, PROD_WEB_BASE);
export type LocalSharing = { accountId: string; epoch: string; enabledAt: number; priorBackend: "local" | "tinfoil" };
export type SharingStatus = {
  accountId: string; available: boolean; sharing: boolean; training: boolean;
  epoch: string | null; revision: number; noticeVersion: string; acceptedNoticeVersion: string | null;
};
export async function sharingRequest(method: string, body?: unknown, token?: string, signal?: AbortSignal): Promise<SharingStatus> {
  const bearer = token ?? await commands.getCloudToken();
  if (!bearer) throw new Error("Sign in to manage sharing.");
  const controller = new AbortController();
  const abort = () => controller.abort();
  signal?.addEventListener("abort", abort, { once: true });
  if (signal?.aborted) controller.abort();
  const timer = setTimeout(abort, 10000);
  try {
    const response = await fetch(endpoint, {
      method, headers: { Authorization: `Bearer ${bearer}`, "Content-Type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: controller.signal, cache: "no-store", credentials: "omit",
    });
    if (!response.ok) throw new Error("Could not update sharing. Refresh and try again.");
    return await response.json();
  } finally { clearTimeout(timer); signal?.removeEventListener("abort", abort); }
}

export type TrajectoryTicket = { local: LocalSharing; token: string; id: string };
type Ports = {
  local: () => Promise<LocalSharing | null>;
  token: () => Promise<string | null>;
  request: typeof sharingRequest;
  redact: (text: string) => Promise<string>;
};
// No raw-content queue, disk writes, retries, telemetry, or error logging.
// Ports let tests prove that revoked/failed turns never cross the upload boundary.
export function createTrajectoryCollector(ports: Ports) {
  const pending = new Set<AbortController>();
  const current = async (ticket: TrajectoryTicket) => {
    const local = await ports.local();
    return local?.epoch === ticket.local.epoch && local.accountId === ticket.local.accountId &&
      await ports.token() === ticket.token;
  };
  return {
    stop() { for (const controller of pending) controller.abort(); },
    async begin(): Promise<TrajectoryTicket | null> {
      const startedAt = Date.now();
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        return await Promise.race([
          (async () => {
            const local = await ports.local();
            if (!local || !Number.isFinite(local.enabledAt) || local.enabledAt >= startedAt) return null;
            const token = await ports.token();
            return token ? { local, token, id: crypto.randomUUID() } : null;
          })(),
          new Promise<null>(resolve => { timer = setTimeout(() => resolve(null), 1000); }),
        ]);
      } catch { return null; }
      finally { clearTimeout(timer); }
    },
    async complete(ticket: TrajectoryTicket | null, question: string, answer: string): Promise<void> {
      if (!ticket || pending.size >= 2 || !question.trim() || !answer.trim() ||
        new TextEncoder().encode(question).length > 1800 || new TextEncoder().encode(answer).length > 1800) return;
      const controller = new AbortController();
      pending.add(controller);
      const timer = setTimeout(() => controller.abort(), 60000);
      try {
        if (!await current(ticket) || controller.signal.aborted) return;
        const consent = await ports.request("GET", undefined, ticket.token, controller.signal);
        if (!consent.available || !consent.sharing || consent.accountId !== ticket.local.accountId ||
          consent.epoch !== ticket.local.epoch || consent.noticeVersion !== SHARING_NOTICE_VERSION ||
          consent.acceptedNoticeVersion !== SHARING_NOTICE_VERSION || !consent.training ||
          controller.signal.aborted || !await current(ticket)) return;
        const redactedQuestion = await ports.redact(question);
        if (controller.signal.aborted || !await current(ticket)) return;
        const redactedAnswer = await ports.redact(answer);
        if (controller.signal.aborted || !await current(ticket)) return;
        await ports.request("POST", {
          id: ticket.id, epoch: ticket.local.epoch, source: "workflows-assistant",
          redaction: "tinfoil-strict-v1", question: redactedQuestion, answer: redactedAnswer,
        }, ticket.token, controller.signal);
      } catch { /* Drop the turn. Trajectory collection failure must not affect the chat. */ }
      finally { clearTimeout(timer); pending.delete(controller); }
    },
  };
}
export const trajectoryCollector = createTrajectoryCollector({
  async local() {
    const { getStore } = await import("@/lib/hooks/use-settings");
    const settings = await (await getStore()).get<import("@/lib/hooks/use-settings").Settings>("settings");
    // Managed deployments never contribute, even if an old local preference exists.
    if (settings?.enterpriseManagedSettings || settings?.piiBackend !== "tinfoil") return null;
    return settings?.workflowSharing ?? null;
  },
  token: () => commands.getCloudToken(),
  request: sharingRequest,
  async redact(text) {
    const result = await commands.redactWorkflowContribution(text);
    if (result.status === "error") throw new Error("Redaction unavailable");
    return result.data;
  },
});
