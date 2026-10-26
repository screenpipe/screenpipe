// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com

import type { NotificationAction } from "./actions";

export function meetingProvider(url: string): string | null {
  try {
    const destination = new URL(url);
    if (!["https:", "http:", "zoommtg:", "zoomus:", "msteams:"].includes(destination.protocol)) return null;
    const host = destination.hostname.toLowerCase().replace(/^\.+|\.+$/g, "");
    const matches = (domain: string) => host === domain || host.endsWith(`.${domain}`);
    if (host === "meet.google.com") return "googleMeet";
    if (["zoom.us", "zoom.com", "zoomgov.com"].some(matches)) return "zoom";
    if (["teams.microsoft.com", "teams.live.com", "teams.cloud.microsoft"].includes(host)) return "teams";
    if (matches("webex.com")) return "webex";
  } catch { /* Unknown destinations retain a generic video icon. */ }
  return null;
}

export function meetingJoinChoices(actions: NotificationAction[]) {
  const join = actions.find((action) => action.type === "meeting_join" && action.url);
  if (!join) return null;
  const capture = actions.find((action) => action.type === "api" &&
    action.url === "/capture/hd/start" && action.method === "POST" &&
    action.body && typeof action.body === "object" && !Array.isArray(action.body));
  return {
    join,
    hd: capture ? { ...join, id: capture.id || "join-hd", screen_detail: capture.body } : null,
  };
}

export function meetingOpenNoteChoices(actions: NotificationAction[]) {
  const openNote = actions.find((action) =>
    (action.id === "open-live-notes" || action.action === "open-live-notes") &&
    action.type === "deeplink" && action.url?.startsWith("screenpipe://meeting")
  );
  if (!openNote) return null;

  const hd = actions.find((action) => action.type === "api" &&
    action.url === "/capture/hd/start" && action.method === "POST" &&
    action.body && typeof action.body === "object" && !Array.isArray(action.body));
  return { openNote, hd: hd ?? null };
}

export function isMeetingNotificationCard(actions: NotificationAction[]) {
  return meetingJoinChoices(actions) !== null || meetingOpenNoteChoices(actions) !== null;
}
