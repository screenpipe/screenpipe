// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com
import type { UsageStatus } from "@/lib/hooks/use-usage-status";
export function workflowAccess(usage: UsageStatus | null) {
  const plan = usage?.hosted_ai?.plan;
  if (!plan || plan === "unknown") return { state: "unavailable", message: "Reconnect to check workflow access and AI allowance." } as const;
  if (!["business", "business_max", "business_ultra", "pro", "pro_max", "pro_ultra", "team", "enterprise"].includes(plan)) return { state: "upgrade", message: "Automatic workflow discovery is included with Business. Your saved workflows remain available." } as const;
  const advisory = usage?.background_pipe_advisory;
  if (usage?.cost_limit_reached || (usage && usage.remaining <= 0) || advisory?.reason === "background_pipe_allowance_low") return { state: "paused", message: usage?.cost_limit_reached || usage?.remaining === 0 ? "Workflow updates are paused because your AI allowance is used up." : "Workflow updates are paused to preserve AI allowance for chat.", resetAt: advisory?.reset_at ?? (usage?.cost_limit_reached ? usage.hosted_ai?.allowances?.find(a => a.remaining_percent === 0)?.resets_at : usage?.resets_at) } as const;
  if (usage?.cost_limit_reached == null) return { state: "unavailable", message: "AI allowance is unavailable. Your saved workflows are still accessible." } as const;
  return { state: "ready", message: "" } as const;
}
