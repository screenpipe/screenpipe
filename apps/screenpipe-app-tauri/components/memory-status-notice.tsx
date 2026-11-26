// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com
"use client";

import { useEffect, useState } from "react";
import { AlertTriangle, Loader2, Unplug } from "lucide-react";
import { useGT } from "gt-react";
import { Button } from "@/components/ui/button";
import type { RecordingAttention } from "./recording-status";

export function MemoryStatusNotice({
  state,
  onCheck,
  onOpenRecording,
  onOpenPermission,
  onOpenStorage,
}: {
  state: RecordingAttention | "low-storage" | undefined;
  onCheck: () => Promise<void>;
  onOpenRecording: () => void;
  onOpenPermission: () => void;
  onOpenStorage: () => void;
}) {
  const ui = useGT();
  const [slowConnection, setSlowConnection] = useState(false);
  const [checking, setChecking] = useState(false);

  useEffect(() => {
    if (state !== "connecting") {
      setSlowConnection(false);
      return;
    }
    // Fast launches need no extra chrome. Keep this visible only if startup
    // or a reconnect takes long enough for the wait to matter.
    const timer = setTimeout(() => setSlowConnection(true), 1_000);
    return () => clearTimeout(timer);
  }, [state]);

  if (!state || (state === "connecting" && !slowConnection)) return null;

  const check = async () => {
    setChecking(true);
    try {
      await onCheck();
    } catch {
      // The shared health state keeps the retry available.
    } finally {
      setChecking(false);
    }
  };
  const checkAction = {
    label: checking ? ui("Checking…") : ui("Check connection"),
    run: () => void check(),
    disabled: checking,
  };
  const notice = {
    connecting: {
      title: ui("Connecting to local history…"),
      detail: ui("You can keep reading or drafting in Chat while Screenpipe connects."),
      action: undefined,
    },
    disconnected: {
      title: ui("Local history is temporarily unavailable"),
      detail: ui("Screenpipe is reconnecting. Open chats and drafts stay here."),
      action: checkAction,
    },
    unavailable: {
      title: ui("Recording status is unavailable"),
      detail: ui("Screenpipe is waiting for an update from the recorder."),
      action: checkAction,
    },
    "screen-permission": {
      title: ui("Screen recording permission needed"),
      detail: ui("Allow screen recording in System Settings to capture new screen history."),
      action: { label: ui("Open System Settings"), run: onOpenPermission },
    },
    "screen-stalled": {
      title: ui("Screen recording stalled"),
      detail: ui("Screenpipe stopped receiving new screen frames."),
      action: { label: ui("Recording settings"), run: onOpenRecording },
    },
    "audio-stalled": {
      title: ui("Audio recording stalled"),
      detail: ui("Screenpipe stopped receiving new audio."),
      action: { label: ui("Recording settings"), run: onOpenRecording },
    },
    "low-storage": {
      title: ui("Recording paused for low storage"),
      detail: ui("Free space to resume recording."),
      action: { label: ui("Manage storage"), run: onOpenStorage },
    },
  }[state];
  const Icon = state === "connecting" ? Loader2 : state === "disconnected" ? Unplug : AlertTriangle;

  return (
    <div data-testid="memory-status-notice" className="flex shrink-0 flex-wrap items-center gap-x-4 gap-y-2 border-b border-border bg-muted/20 px-4 py-2.5 sm:px-6">
      <div role="status" className="flex min-w-0 flex-1 basis-56 items-start gap-2.5 text-xs leading-5">
        <Icon aria-hidden="true" className={state === "connecting" ? "mt-0.5 size-4 shrink-0 motion-safe:animate-spin" : "mt-0.5 size-4 shrink-0"} />
        <p>
          <span className="font-medium">{notice.title}</span>{" "}
          <span className="text-muted-foreground">{notice.detail}</span>
        </p>
      </div>
      {notice.action && (
        <Button type="button" variant="outline" size="sm" className="h-7 px-2.5 font-sans normal-case tracking-normal"
          onClick={notice.action.run} disabled={"disabled" in notice.action && notice.action.disabled}>
          {notice.action.label}
        </Button>
      )}
    </div>
  );
}
