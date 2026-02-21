"use client";

import React, { useState, useEffect, useCallback, useRef } from "react";
import { Card, CardContent } from "@/components/ui/card";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import {
  AlertCircle,
  Bell,
  CheckCircle2,
  ExternalLink,
  Loader2,
  XCircle,
} from "lucide-react";
import { platform } from "@tauri-apps/plugin-os";
import { invoke } from "@tauri-apps/api/core";
import { openUrl } from "@tauri-apps/plugin-opener";
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

  // Reminders state
  const [remindersAvailable, setRemindersAvailable] = useState(false);
  const [remindersAuthorized, setRemindersAuthorized] = useState(false);
  const [authDenied, setAuthDenied] = useState(false);
  const [remindersEnabled, setRemindersEnabled] = useState(false);
  const [schedulerRunning, setSchedulerRunning] = useState(false);
  const [isAuthorizing, setIsAuthorizing] = useState(false);
  const [isScanning, setIsScanning] = useState(false);
  const [lastScanResult, setLastScanResult] = useState<string | null>(null);
  const [reminderCount, setReminderCount] = useState(0);
  const [customPrompt, setCustomPrompt] = useState("");
  const [promptDirty, setPromptDirty] = useState(false);
  const [audioOnly, setAudioOnly] = useState(true);
  const saveTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    setOs(platform());
  }, []);

  // Load AI enabled state
  useEffect(() => {
    try {
      const stored = localStorage?.getItem("apple-intelligence-enabled");
      if (stored !== null) setEnabled(stored !== "false");
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
    const attempt = async () => {
      const resp = await fetch(`${API}/ai/status`, {
        signal: AbortSignal.timeout(10000),
      });
      if (resp.ok) {
        const data = await resp.json();
        return data.available ? "available" : "unavailable";
      }
      return null;
    };

    try {
      let result = await attempt();
      // Retry once after 2s if the first attempt failed
      if (result === null) {
        await new Promise((r) => setTimeout(r, 2000));
        result = await attempt();
      }
      if (result) {
        setAiStatus(result as "available" | "unavailable");
        if (!statusCapturedRef.current) {
          statusCapturedRef.current = true;
          posthog.capture("apple_intelligence_status", {
            available: result === "available",
            enabled,
          });
        }
      } else {
        setAiStatus("unavailable");
      }
    } catch {
      // On network error, retry once
      try {
        await new Promise((r) => setTimeout(r, 2000));
        const result = await attempt();
        setAiStatus(
          result ? (result as "available" | "unavailable") : "unavailable"
        );
      } catch {
        setAiStatus("unavailable");
      }
    }
  }, [enabled, setAiStatus]);

  useEffect(() => {
    checkStatus();
    const interval = setInterval(checkStatus, 30000);
    return () => clearInterval(interval);
  }, [checkStatus]);

  // Check reminders status via Tauri command
  const checkRemindersStatus = useCallback(async () => {
    try {
      const status = await invoke<{
        available: boolean;
        authorized: boolean;
        authorizationStatus: string;
        schedulerRunning: boolean;
        reminderCount: number;
      }>("reminders_status");
      setRemindersAvailable(status.available);
      setRemindersAuthorized(status.authorized);
      setSchedulerRunning(status.schedulerRunning);
      setReminderCount(status.reminderCount);
      setRemindersEnabled(status.schedulerRunning);
      if (status.authorizationStatus === "Denied") {
        setAuthDenied(true);
      }
      if (status.authorized) {
        invoke<string>("reminders_get_custom_prompt")
          .then((p) => setCustomPrompt(p))
          .catch(() => {});
        invoke<boolean>("reminders_get_audio_only")
          .then((v) => setAudioOnly(v))
          .catch(() => {});
      }
    } catch {}
  }, []);

  useEffect(() => {
    if (aiStatus === "available") {
      checkRemindersStatus();
    }
  }, [aiStatus, checkRemindersStatus]);

  // Auto-save custom prompt (debounced 1s)
  const onCustomPromptChange = (value: string) => {
    setCustomPrompt(value);
    setPromptDirty(true);
    if (saveTimeoutRef.current) clearTimeout(saveTimeoutRef.current);
    saveTimeoutRef.current = setTimeout(async () => {
      await invoke("reminders_set_custom_prompt", { prompt: value }).catch(
        () => {}
      );
      setPromptDirty(false);
    }, 1000);
  };

  const toggleAudioOnly = async (val: boolean) => {
    setAudioOnly(val);
    await invoke("reminders_set_audio_only", { audioOnly: val }).catch(() => {});
    posthog.capture("reminders_audio_only_toggled", { audio_only: val });
  };

  // Authorize reminders
  const authorizeReminders = async () => {
    setIsAuthorizing(true);
    setAuthDenied(false);
    try {
      const result = await invoke<string>("reminders_authorize");
      if (result === "granted") {
        setRemindersAuthorized(true);
        posthog.capture("reminders_authorized", { result: "granted" });
      } else {
        setAuthDenied(true);
        posthog.capture("reminders_authorized", { result: "denied" });
      }
    } catch (e) {
      posthog.capture("reminders_authorized", {
        result: "error",
        error: String(e),
      });
    }
    setIsAuthorizing(false);
  };

  // Toggle scheduler via Tauri commands (persistent, survives page navigation)
  const toggleReminders = async (val: boolean) => {
    try {
      if (val) {
        await invoke("reminders_start_scheduler");
        setRemindersEnabled(true);
        setSchedulerRunning(true);
        posthog.capture("reminders_scheduler_started");
      } else {
        await invoke("reminders_stop_scheduler");
        setRemindersEnabled(false);
        setSchedulerRunning(false);
        posthog.capture("reminders_scheduler_stopped");
      }
    } catch (e) {
      console.error("Failed to toggle reminders scheduler:", e);
    }
  };

  // Manual scan
  const triggerScan = async () => {
    setIsScanning(true);
    setLastScanResult(null);
    try {
      const scanPromise = invoke<{
        remindersCreated: number;
        items: { title: string }[];
        contextChars: number;
        error: string | null;
      }>("reminders_scan", {
        customPrompt: customPrompt || null,
        audioOnly,
      });

      const timeoutPromise = new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("scan timed out after 60s")), 60000)
      );

      const result = await Promise.race([scanPromise, timeoutPromise]);

      if (result.error) {
        setLastScanResult(result.error);
      } else if (result.remindersCreated > 0) {
        const names = result.items
          .map((i) => i.title)
          .slice(0, 3)
          .join(", ");
        setLastScanResult(
          `${result.remindersCreated} created — ${names}`
        );
        setReminderCount((c) => c + result.remindersCreated);
      } else {
        setLastScanResult("no action items found");
      }
      posthog.capture("reminders_scan_manual", {
        reminders_created: result.remindersCreated,
        context_chars: result.contextChars,
        had_error: !!result.error,
      });
    } catch (e) {
      setLastScanResult("scan failed — try again");
      posthog.capture("reminders_scan_error", { error: String(e) });
    }
    setIsScanning(false);
  };

  if (os && os !== "macos") return null;

  const showReminders =
    aiStatus === "available" && enabled && remindersAvailable;

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
              Generates a daily summary of your activity in the timeline at 6pm.
              Includes time breakdown, key moments, action items, and people
              mentioned. Runs entirely on-device using Apple&apos;s Foundation
              Models. Only processes when plugged in.
            </p>

            {aiStatus === "unavailable" && (
              <p className="text-xs text-muted-foreground mb-3">
                <AlertCircle className="h-3 w-3 inline mr-1" />
                Requires macOS 26+ with Apple Intelligence enabled.
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

        {/* Reminders section */}
        {showReminders && (
          <div className="px-4 pb-4 pt-1 border-t border-border">
            <div className="flex items-center gap-2 mt-3 mb-2">
              <Bell className="h-4 w-4 text-muted-foreground" />
              <h4 className="text-sm font-medium text-foreground">
                Auto Reminders
              </h4>
              {remindersAuthorized && reminderCount > 0 && (
                <span className="px-2 py-0.5 text-xs font-medium bg-muted text-muted-foreground rounded-full">
                  {reminderCount} active
                </span>
              )}
            </div>

            <p className="text-xs text-muted-foreground mb-3 leading-relaxed break-words">
              Scans your screen &amp; audio every 30 minutes, extracts action
              items with AI, and saves them to a &quot;Screenpipe&quot; list in
              Apple Reminders.
            </p>

            {!remindersAuthorized ? (
              <div className="space-y-2">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={authorizeReminders}
                  disabled={isAuthorizing || authDenied}
                  className="text-xs"
                >
                  {isAuthorizing ? (
                    <Loader2 className="h-3 w-3 mr-1.5 animate-spin" />
                  ) : authDenied ? (
                    <XCircle className="h-3 w-3 mr-1.5" />
                  ) : (
                    <Bell className="h-3 w-3 mr-1.5" />
                  )}
                  {authDenied
                    ? "Access denied"
                    : "Connect Apple Reminders"}
                </Button>

                {authDenied && (
                  <p className="text-xs text-muted-foreground">
                    Open{" "}
                    <span className="font-medium">
                      System Settings → Privacy & Security → Reminders
                    </span>{" "}
                    and enable screenpipe, then restart the app.
                  </p>
                )}
              </div>
            ) : (
              <div className="space-y-3">
                <div className="flex items-center gap-3">
                  <Switch
                    checked={remindersEnabled}
                    onCheckedChange={toggleReminders}
                  />
                  <Label className="text-xs text-muted-foreground">
                    {remindersEnabled
                      ? "Auto-scanning every 30 min"
                      : "Auto-scan disabled"}
                  </Label>
                </div>

                <div className="flex items-center gap-3">
                  <Switch
                    checked={audioOnly}
                    onCheckedChange={toggleAudioOnly}
                  />
                  <Label className="text-xs text-muted-foreground">
                    audio only (skip screen data)
                  </Label>
                </div>

                <Textarea
                  value={customPrompt}
                  onChange={(e) => onCustomPromptChange(e.target.value)}
                  placeholder="e.g. focus on coding tasks and bugs · ignore social media · always set due date to tomorrow"
                  className="text-xs min-h-[36px] h-9 resize-none font-mono"
                  rows={1}
                />

                <div className="flex items-start gap-2 flex-wrap">
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => !isScanning && triggerScan()}
                    className="text-xs min-w-[110px] gap-1.5"
                  >
                    {isScanning ? (
                      <Loader2 className="h-3 w-3 shrink-0 animate-spin" />
                    ) : (
                      <CheckCircle2 className="h-3 w-3 shrink-0" />
                    )}
                    <span>{isScanning ? "scanning…" : "scan now"}</span>
                  </Button>

                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => openUrl("x-apple-reminderkit://")}
                    className="text-xs"
                  >
                    <ExternalLink className="h-3 w-3 mr-1.5" />
                    Open Reminders
                  </Button>

                  {lastScanResult && (
                    <span className="text-xs text-muted-foreground pt-1.5 break-words min-w-0">
                      {lastScanResult}
                    </span>
                  )}
                </div>
              </div>
            )}
          </div>
        )}

        {/* Status bar */}
        <div className="px-4 py-2 bg-muted/50 border-t border-border">
          <div className="flex items-center gap-3 text-xs text-muted-foreground">
            <span>
              {showReminders && remindersAuthorized && remindersEnabled
                ? "Summaries + reminders active · scanning every 30 min"
                : "Summaries appear in your timeline · you can also generate manually"}
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
