"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import { Card, CardContent } from "@/components/ui/card";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import {
  AlertCircle,
} from "lucide-react";
import { platform } from "@tauri-apps/plugin-os";
import posthog from "posthog-js";

const API = "http://localhost:3030";

export function AppleIntelligenceCard() {
  const [os, setOs] = useState<string>("");
  const [aiStatus, setAiStatusRaw] = useState<
    "unknown" | "available" | "unavailable"
  >(() => {
    try {
      const cached = localStorage?.getItem("apple-intelligence-status");
      if (cached === "available" || cached === "unavailable") return cached;
    } catch {}
    return "unknown";
  });
  const [aiStatusReason, setAiStatusReason] = useState<string>("");
  const [enabled, setEnabled] = useState(true);

  // Wrap setAiStatus to persist to localStorage
  const setAiStatus = useCallback(
    (status: "unknown" | "available" | "unavailable") => {
      setAiStatusRaw(status);
      if (status !== "unknown") {
        try {
          localStorage?.setItem("apple-intelligence-status", status);
        } catch {}
      }
    },
    []
  );

  useEffect(() => {
    setOs(platform());
  }, []);

  // Load AI enabled state — default to true only on macOS 26+ with 32GB+ RAM
  useEffect(() => {
    try {
      const stored = localStorage?.getItem("apple-intelligence-enabled");
      if (stored !== null) {
        setEnabled(stored !== "false");
        return;
      }
      // No stored preference — auto-detect based on hardware
      if (platform() === "macos") {
        import("@/lib/utils/tauri").then(({ commands }) => {
          commands.getHardwareCapability().then((hw) => {
            const meetsRequirements = hw.totalMemoryGb >= 16;
            setEnabled(meetsRequirements);
          }).catch(() => {});
        });
      } else {
        setEnabled(false);
      }
    } catch {}
  }, []);

  const toggleEnabled = (val: boolean) => {
    setEnabled(val);
    try {
      localStorage?.setItem("apple-intelligence-enabled", String(val));
    } catch {}
    posthog.capture(
      val ? "apple_intelligence_enabled" : "apple_intelligence_disabled"
    );
  };

  const statusCapturedRef = useRef(false);

  // Check AI availability (with retry on failure)
  const checkStatus = useCallback(async () => {
    const attempt = async (): Promise<{ available: boolean; status: string } | null> => {
      const resp = await fetch(`${API}/ai/status`, {
        signal: AbortSignal.timeout(10000),
      });
      if (resp.ok) {
        return await resp.json();
      }
      console.warn("[apple-intelligence] /ai/status returned", resp.status, resp.statusText);
      return null;
    };

    try {
      let data = await attempt();
      // Retry once after 2s if the first attempt failed
      if (data === null) {
        await new Promise((r) => setTimeout(r, 2000));
        data = await attempt();
      }
      if (data) {
        const result = data.available ? "available" : "unavailable";
        console.log("[apple-intelligence] status:", data.status, "available:", data.available);
        setAiStatus(result);
        setAiStatusReason(data.status || "");
        if (!statusCapturedRef.current) {
          statusCapturedRef.current = true;
          posthog.capture("apple_intelligence_status", {
            available: data.available,
            status: data.status,
            enabled,
          });
        }
      } else {
        console.warn("[apple-intelligence] /ai/status unreachable — endpoint may not be compiled in");
        setAiStatus("unavailable");
        setAiStatusReason("endpoint unreachable — build may not include apple-intelligence feature");
      }
    } catch (e) {
      // On network error, retry once
      try {
        await new Promise((r) => setTimeout(r, 2000));
        const data = await attempt();
        if (data) {
          setAiStatus(data.available ? "available" : "unavailable");
          setAiStatusReason(data.status || "");
        } else {
          setAiStatus("unavailable");
          setAiStatusReason("endpoint unreachable");
        }
      } catch {
        console.error("[apple-intelligence] /ai/status failed after retry:", e);
        setAiStatus("unavailable");
        setAiStatusReason("network error");
      }
    }
  }, [enabled, setAiStatus]);

  useEffect(() => {
    checkStatus();
    const interval = setInterval(checkStatus, 30000);
    return () => clearInterval(interval);
  }, [checkStatus]);

  if (os && os !== "macos") return null;

  return (
    <Card className="border-border bg-card overflow-hidden">
      <CardContent className="p-0">
        <div className="flex items-start p-4 gap-4">
          <div className="flex-shrink-0">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src="/apple-intelligence-logo.svg"
              alt="Apple Intelligence"
              className="w-10 h-10 rounded-xl"
            />
          </div>

          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 mb-1">
              <h3 className="text-sm font-semibold text-foreground">
                Apple Intelligence
              </h3>
              <span className="px-2 py-0.5 text-xs font-medium bg-muted text-muted-foreground rounded-full">
                on-device
              </span>
              {aiStatus === "available" && (
                <span className="px-2 py-0.5 text-xs font-medium bg-foreground text-background rounded-full">
                  available
                </span>
              )}
            </div>

            <p className="text-xs text-muted-foreground mb-3 leading-relaxed">
              Generates a daily summary of your activity in the timeline at 6pm
              and suggests follow-up actions in the chat.
              Includes time breakdown, key moments, action items, and people
              mentioned. Runs entirely on-device using Apple&apos;s Foundation
              Models. Only processes when plugged in.
            </p>

            {aiStatus === "unavailable" && (
              <p className="text-xs text-muted-foreground mb-3">
                <AlertCircle className="h-3 w-3 inline mr-1" />
                {aiStatusReason
                  ? `Not available: ${aiStatusReason}`
                  : "Requires macOS 26+ with Apple Intelligence enabled."}
              </p>
            )}

            <div className="flex items-center gap-3">
              <Switch
                checked={enabled}
                onCheckedChange={toggleEnabled}
                disabled={aiStatus !== "available"}
              />
              <Label className="text-xs text-muted-foreground">
                {enabled
                  ? "Daily summaries enabled"
                  : "Daily summaries disabled"}
              </Label>
            </div>
          </div>
        </div>

        {/* Status bar */}
        <div className="px-4 py-2 bg-muted/50 border-t border-border">
          <div className="flex items-center gap-3 text-xs text-muted-foreground">
            <span>
              Summaries appear in your timeline · you can also generate manually
            </span>
            <span className="ml-auto">
              {aiStatus === "available"
                ? "● on-device"
                : aiStatus === "unavailable"
                  ? "○ not available"
                  : "○ checking..."}
            </span>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
