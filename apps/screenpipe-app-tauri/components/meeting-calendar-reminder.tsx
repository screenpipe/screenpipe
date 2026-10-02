// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com
"use client";

import { useEffect } from "react";
import { useGT } from "gt-react";
import {
  appendAuthToken,
  ensureApiReady,
  getApiBaseUrl,
  localFetch,
} from "@/lib/api";
import { getStore, type Settings } from "@/lib/hooks/use-settings";
import { appServerFetch } from "@/lib/notifications/app-server";
import { writeBrowserLogNow } from "@/lib/logging/browser-log";
import {
  calendarNudgeAvailable,
  eligibleCalendarMeeting,
  observeCalendarNudgeMeeting,
  withCalendarNudge,
} from "@/lib/calendar-nudge";
import { CALENDAR_CONNECTIONS_URL } from "@/lib/notifications/actions";
import type { MeetingStatusResponse } from "@/lib/utils/meeting-state";
import type { MeetingRecord } from "@/lib/utils/meeting-format";

type Translate = (text: string) => string;

export async function sendCalendarReminder(
  ui: Translate,
  stillIdle: () => boolean,
): Promise<void> {
  await withCalendarNudge(async (state, save) => {
    if (
      state.dismissed ||
      state.reminderConsumed ||
      !state.candidateMeetingId ||
      !stillIdle()
    )
      return;
    const store = await getStore();
    const settings = await store.get<Settings>("settings");
    const prefs = settings?.notificationPrefs;
    if (prefs?.meetingLiveNotes === false) return;
    if (!(await calendarNudgeAvailable())) return;
    const meetingResponse = await localFetch(
      `/meetings/${state.candidateMeetingId}`,
    );
    if (!meetingResponse.ok)
      throw new Error(`meeting lookup HTTP ${meetingResponse.status}`);
    const meeting = (await meetingResponse.json()) as MeetingRecord;
    if (!meeting.meeting_end || !eligibleCalendarMeeting(meeting)) return;
    // Recheck after calendar/meeting requests: another call may have started.
    const statusResponse = await localFetch("/meetings/status");
    if (!statusResponse.ok)
      throw new Error(`meeting status HTTP ${statusResponse.status}`);
    const status = (await statusResponse.json()) as MeetingStatusResponse;
    if (status.active !== false || !stillIdle()) return;
    // Persist before delivery: a timeout or process exit must not send it twice.
    await save({ ...state, reminderConsumed: true });
    const response = await appServerFetch("/notify", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        id: "meeting-calendar-connect",
        type: "meeting",
        priority: "normal",
        title: ui("Add details to your next meeting"),
        body: ui(
          "Connect your calendar for scheduled meeting titles, attendees, and upcoming meetings.",
        ),
        timeout: 20_000,
        actions: [
          {
            id: "connect-calendar",
            label: ui("Connect calendar"),
            type: "deeplink",
            url: CALENDAR_CONNECTIONS_URL,
            primary: true,
          },
        ],
      }),
    });
    if (!response.ok)
      throw new Error(`calendar reminder delivery HTTP ${response.status}`);
    const receipt = await response.json();
    if (receipt.success !== true)
      throw new Error(`calendar reminder rejected: ${receipt.message}`);
    writeBrowserLogNow(
      "info",
      `calendar reminder delivery: ${receipt.message}`,
    );
  });
}

/** Home stays mounted when hidden; share its lifetime across settings navigation. */
export function MeetingCalendarReminder() {
  const ui = useGT();
  useEffect(() => {
    let cancelled = false;
    let socket: WebSocket | null = null;
    let retry: ReturnType<typeof setTimeout> | undefined;
    let backoff = 1000;
    let latest: MeetingStatusResponse | null = null;
    let lastKey: string | null = null;
    let work = Promise.resolve();
    const connect = async () => {
      try {
        await ensureApiReady();
        if (cancelled) return;
        socket = new WebSocket(
          appendAuthToken(
            `${getApiBaseUrl().replace("http://", "ws://")}/ws/meeting-status`,
          ),
        );
        socket.onopen = () => {
          backoff = 1000;
          lastKey = null;
        };
        socket.onmessage = (event) => {
          try {
            const status = JSON.parse(event.data) as MeetingStatusResponse;
            if (typeof status.active !== "boolean") return;
            latest = status;
            const key = JSON.stringify([status.active, status.activeMeetingId]);
            if (key === lastKey) return;
            lastKey = key;
            work = work
              .then(async () => {
                if (cancelled) return;
                if (status.active) await observeCalendarNudgeMeeting(status);
                else
                  await sendCalendarReminder(
                    ui,
                    () => !cancelled && latest?.active === false,
                  );
              })
              .catch((error) => {
                writeBrowserLogNow(
                  "error",
                  `calendar reminder not confirmed: ${String(error)}`,
                );
              });
          } catch {
            /* Malformed status is unknown, never a meeting end. */
          }
        };
        socket.onclose = () => {
          latest = null;
          if (!cancelled) {
            retry = setTimeout(connect, backoff);
            backoff = Math.min(backoff * 2, 10000);
          }
        };
        socket.onerror = () => socket?.close();
      } catch (error) {
        writeBrowserLogNow(
          "warn",
          `calendar reminder status unavailable: ${String(error)}`,
        );
        if (!cancelled) retry = setTimeout(connect, 10000);
      }
    };
    void connect();
    return () => {
      cancelled = true;
      if (retry) clearTimeout(retry);
      socket?.close(1000, "unmount");
    };
  }, [ui]);
  return null;
}
