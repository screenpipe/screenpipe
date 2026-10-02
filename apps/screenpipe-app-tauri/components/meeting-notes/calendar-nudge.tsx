// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com
"use client";

import React, { useEffect, useState } from "react";
import { CalendarDays, X } from "lucide-react";
import { useGT } from "gt-react";
import posthog from "posthog-js";
import {
  claimInlineCalendarNudge,
  dismissCalendarNudge,
} from "@/lib/calendar-nudge";
import type { MeetingRecord } from "@/lib/utils/meeting-format";
import { Button } from "@/components/ui/button";

export function CalendarNudge({
  meeting,
  onConnect,
}: {
  meeting: MeetingRecord;
  onConnect: () => void;
}) {
  const ui = useGT();
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    let cancelled = false;
    const check = async () => {
      if (document.visibilityState !== "visible") return;
      try {
        const show = await claimInlineCalendarNudge(
          meeting,
          () => !cancelled && document.visibilityState === "visible",
        );
        if (!cancelled) setVisible(show);
      } catch (error) {
        console.warn("calendar nudge: inline eligibility unavailable", error);
      }
    };
    void check();
    document.addEventListener("visibilitychange", check);
    window.addEventListener("focus", check);
    return () => {
      cancelled = true;
      document.removeEventListener("visibilitychange", check);
      window.removeEventListener("focus", check);
    };
  }, [meeting.id]);

  if (!visible)
    return (
      <button
        type="button"
        className="mb-3 text-xs text-muted-foreground hover:text-foreground"
        onClick={onConnect}
      >
        {ui("Calendar connections")}
      </button>
    );
  return (
    <div
      className="mb-4 flex items-start gap-3 rounded-md border border-border bg-muted/20 p-3"
      role="region"
      aria-label={ui("Connect your calendar")}
    >
      <CalendarDays
        className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground"
        aria-hidden
      />
      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium">
          {ui("Add meeting details automatically")}
        </p>
        <p className="mt-1 text-xs text-muted-foreground">
          {ui(
            "Connect your calendar for scheduled meeting titles, attendees, and upcoming meetings.",
          )}
        </p>
        <Button
          variant="outline"
          size="sm"
          className="mt-2 h-7 text-xs"
          onClick={() => {
            posthog.capture("meeting_calendar_nudge_clicked", {
              surface: "note",
            });
            onConnect();
          }}
        >
          {ui("Connect calendar")}
        </Button>
      </div>
      <button
        type="button"
        className="rounded p-1 text-muted-foreground hover:text-foreground"
        aria-label={ui("Dismiss calendar reminder")}
        onClick={() => {
          setVisible(false);
          void dismissCalendarNudge().catch((error) =>
            console.error(
              "calendar nudge: dismissal could not be saved",
              error,
            ),
          );
          posthog.capture("meeting_calendar_nudge_dismissed", {
            surface: "note",
          });
        }}
      >
        <X className="h-4 w-4" />
      </button>
    </div>
  );
}
