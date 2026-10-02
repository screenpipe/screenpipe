// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com

import { getStore, saveAndEncrypt } from "@/lib/hooks/use-settings";
import posthog from "posthog-js";
import { fetchUpcomingCalendarSnapshot } from "@/lib/utils/calendar";
import type { MeetingRecord } from "@/lib/utils/meeting-format";

export const CALENDAR_NUDGE_KEY = "meetingCalendarNudge";
export interface CalendarNudgeState {
  inlineMeetingId?: number;
  reminderConsumed?: boolean;
  dismissed?: boolean;
  candidateMeetingId?: number;
}

// Serialize note, background, and settings actions across app windows so
// they share one interruption budget. Chat persistence uses the same primitive.
export async function withCalendarNudge<T>(
  operation: (
    state: CalendarNudgeState,
    save: (next: CalendarNudgeState) => Promise<void>,
  ) => Promise<T>,
): Promise<T | undefined> {
  if (!navigator.locks) return undefined; // Never risk duplicate prompts.
  return navigator.locks.request(CALENDAR_NUDGE_KEY, async () => {
    const store = await getStore();
    const state =
      (await store.get<CalendarNudgeState>(CALENDAR_NUDGE_KEY)) ?? {};
    return operation(state, async (next) => {
      await store.set(CALENDAR_NUDGE_KEY, next);
      await saveAndEncrypt(store);
    });
  });
}

export function eligibleCalendarMeeting(
  meeting: Pick<MeetingRecord, "meeting_app" | "detection_source">,
): boolean {
  return (
    Boolean(meeting.meeting_app) &&
    meeting.meeting_app !== "manual" &&
    Boolean(meeting.detection_source) &&
    meeting.detection_source !== "manual"
  );
}

export async function calendarNudgeAvailable(): Promise<boolean> {
  const store = await getStore();
  if ((await store.get<boolean>("calendarUserDisconnected")) === true)
    return false;
  const snapshot = await fetchUpcomingCalendarSnapshot();
  return (
    snapshot.connectedSources.length === 0 &&
    snapshot.unknownSources.length === 0
  );
}

export async function dismissCalendarNudge(): Promise<void> {
  await withCalendarNudge(async (state, save) => {
    await save({ ...state, dismissed: true, reminderConsumed: true });
  });
}

export async function claimInlineCalendarNudge(
  meeting: MeetingRecord,
  isVisible: () => boolean = () => document.visibilityState === "visible",
): Promise<boolean> {
  if (!eligibleCalendarMeeting(meeting)) return false;
  return (
    (await withCalendarNudge(async (state, save) => {
      if (
        state.dismissed ||
        (state.reminderConsumed && state.inlineMeetingId == null) ||
        (state.inlineMeetingId != null && state.inlineMeetingId !== meeting.id)
      )
        return false;
      if (!(await calendarNudgeAvailable()) || !isVisible()) return false;
      await save({
        ...state,
        inlineMeetingId: meeting.id,
        reminderConsumed: true,
      });
      if (state.inlineMeetingId == null)
        posthog.capture("meeting_calendar_nudge_shown", { surface: "note" });
      return true;
    })) ?? false
  );
}

export async function observeCalendarNudgeMeeting(
  status: import("@/lib/utils/meeting-state").MeetingStatusResponse,
): Promise<void> {
  await withCalendarNudge(async (state, save) => {
    if (
      state.dismissed ||
      state.reminderConsumed ||
      !status.active ||
      !status.activeMeetingId
    )
      return;
    if (
      !eligibleCalendarMeeting({
        meeting_app: status.meetingApp ?? "",
        detection_source: status.detectionSource ?? "",
      })
    )
      return;
    if (state.candidateMeetingId !== status.activeMeetingId)
      await save({ ...state, candidateMeetingId: status.activeMeetingId });
  });
}
