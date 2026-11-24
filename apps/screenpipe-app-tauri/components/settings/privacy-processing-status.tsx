// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com
"use client";

import { useEffect, useState } from "react";
import { RedactionHistory } from "./redaction-history";
import { useGT } from "gt-react";
import { ChevronDown } from "lucide-react";
import { localFetch } from "@/lib/api";
import { PRIVACY_STATUS_POLL_INTERVAL_MS } from "@/lib/privacy-processing";

export type PrivacyQueueStatus = {
  enabled: boolean;
  scope: "protected_capture_surfaces";
  surfaces: {
    kind: string;
    discovering: boolean;
    pending: number;
    pending_capped: boolean;
    deferred: number;
  }[];
};

function validStatus(value: unknown): value is PrivacyQueueStatus {
  if (!value || typeof value !== "object") return false;
  const status = value as PrivacyQueueStatus;
  return typeof status.enabled === "boolean" && status.scope === "protected_capture_surfaces" &&
    Array.isArray(status.surfaces) && (!status.enabled || status.surfaces.length > 0) && status.surfaces.every((surface) =>
      typeof surface.kind === "string" && typeof surface.discovering === "boolean" &&
      Number.isSafeInteger(surface.pending) && surface.pending >= 0 &&
      Number.isSafeInteger(surface.deferred) && surface.deferred >= 0 &&
      typeof surface.pending_capped === "boolean");
}

export function PrivacyStatusView({ status, unavailable }: {
  status: PrivacyQueueStatus | null;
  unavailable: boolean;
}) {
  const ui = useGT();
  const [detailsOpen, setDetailsOpen] = useState(false);
  const discovering = status?.surfaces.some((s) => s.discovering);
  const pending = status?.surfaces.reduce((sum, s) => sum + s.pending, 0) ?? 0;
  const textSurfaces = status?.surfaces.filter((s) => s.kind !== "image") ?? [];
  const imageSurface = status?.surfaces.find((s) => s.kind === "image");
  const textEnabled = textSurfaces.length > 0;
  const imageEnabled = !!imageSurface;
  const textPending = textSurfaces.reduce((sum, s) => sum + s.pending, 0);
  const textPendingCapped = textSurfaces.some((s) => s.pending_capped || s.discovering);
  const imagePending = imageSurface?.pending ?? 0;
  const imagePendingCapped = !!imageSurface && (imageSurface.pending_capped || imageSurface.discovering);
  const retrying = status?.surfaces.some((s) => s.deferred > 0);
  const title = unavailable ? ui("Processing status unavailable")
    : !status ? ui("Checking privacy processing")
    : !status.enabled ? ui("Waiting for protection to start")
    : discovering ? ui("Checking existing history")
    : retrying ? ui("Privacy processing will retry")
    : pending > 0 ? ui("Privacy processing") : ui("Enabled privacy checks complete");

  return <div className="mt-3 border-t border-border pt-3 text-xs" data-testid="privacy-processing-status">
    <p role="status" className="font-medium text-foreground">{title}</p>
    <p className="mt-1 text-muted-foreground">
      {unavailable ? ui("The status check failed. It will retry automatically; processing state is unknown.")
        : status && !status.enabled ? ui("Protection is not active in the recording engine yet. Check your recording settings if this persists.")
        : ui("Recording continues. New data becomes available after its privacy checks finish.")}
    </p>
    {status?.enabled && !unavailable && <div className="mt-3 border-t border-border pt-2">
      <dl className="grid max-w-sm grid-cols-[1fr_auto] gap-x-4 gap-y-1.5 text-xs text-muted-foreground">
        <dt>{ui("Text records waiting")}</dt>
        <dd className="text-right font-medium tabular-nums text-foreground">{!textEnabled ? ui("Not enabled") : <>{textPending.toLocaleString()}{textPendingCapped ? "+" : ""}</>}</dd>
        <dt>{ui("Screenshots waiting")}</dt>
        <dd className="text-right font-medium tabular-nums text-foreground">{!imageEnabled ? ui("Not enabled") : <>{imagePending.toLocaleString()}{imagePendingCapped ? "+" : ""}</>}</dd>
      </dl>
      {discovering && <p className="mt-1.5 text-xs text-muted-foreground">{ui("Scanning existing history. Counts can increase while discovery continues.")}</p>}
      <button
        type="button"
        aria-expanded={detailsOpen}
        aria-controls="privacy-processing-details"
        onClick={() => setDetailsOpen((open) => !open)}
        className="mt-2 flex items-center gap-1.5 text-left text-xs text-muted-foreground hover:text-foreground focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-foreground"
      >
        <span className="font-medium">{ui("About these counts")}</span>
        <ChevronDown aria-hidden="true" size={14} className={`shrink-0 transition-transform ${detailsOpen ? "rotate-180" : ""}`} />
      </button>
      {detailsOpen && <div id="privacy-processing-details" className="mt-2 space-y-1.5 text-xs text-muted-foreground">
        <p>{ui("Text and screenshots finish separately. This status covers privacy processing, not upload completion.")}</p>
        <p>{ui("Some live and derived-data features are unavailable with protection enabled.")}</p>
      </div>}
    </div>}
  </div>;
}

/** Poll only while the settings card is mounted and visible. Keep requests
 * sequential and bounded; a slow or unavailable engine cannot stack polls. */
export function PrivacyProcessingStatus() {
  const [status, setStatus] = useState<PrivacyQueueStatus | null>(null);
  const [unavailable, setUnavailable] = useState(false);
  useEffect(() => {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    let controller: AbortController | undefined;
    const poll = async () => {
      if (stopped) return;
      if (document.visibilityState !== "hidden") {
        controller = new AbortController();
        const timeout = setTimeout(() => controller?.abort(), 5000);
        try {
          const response = await localFetch("/privacy/status", { signal: controller.signal });
          if (!response.ok) throw new Error("status unavailable");
          const value: unknown = await response.json();
          if (!validStatus(value)) throw new Error("invalid status");
          if (!stopped) { setStatus(value); setUnavailable(false); }
        } catch {
          if (!stopped) { setStatus(null); setUnavailable(true); }
        } finally { clearTimeout(timeout); }
      }
      if (!stopped) timer = setTimeout(poll, PRIVACY_STATUS_POLL_INTERVAL_MS);
    };
    void poll();
    return () => { stopped = true; clearTimeout(timer); controller?.abort(); };
  }, []);
  return <>
    <PrivacyStatusView status={status} unavailable={unavailable} />
    <RedactionHistory />
  </>;
}
