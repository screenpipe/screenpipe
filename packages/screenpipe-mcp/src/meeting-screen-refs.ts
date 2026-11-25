// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com

type MeetingWindow = {
  meeting_app?: unknown;
  meeting_start?: unknown;
  meeting_end?: unknown;
  title?: unknown;
};

type ScreenFrame = {
  frame_id: number;
  timestamp: string;
  app_name?: string;
  window_name?: string;
  browser_url?: string | null;
  text_source?: string | null;
};

type SearchPage = {
  data?: Array<{ type: string; content: ScreenFrame }>;
  pagination?: { total: number };
};

type ScreenRef = {
  frame_id: number;
  timestamp: string;
  screenshot_uri: string;
  text_source: "accessibility" | "ocr" | null;
};

type ScreenRefs = {
  screen_refs: ScreenRef[];
  screen_refs_status: "matched" | "no_match" | "ambiguous" | "unavailable" | "not_checked";
};

const SEARCH_LIMIT = 100;
export const MEETING_LIST_SCREEN_REF_LIMIT = 10;
const LOOKUP_TIMEOUT_MS = 2500;

function normalize(value: unknown): string {
  return typeof value === "string" ? value.trim().toLowerCase().replace(/\s+/g, " ") : "";
}

function meetingProvider(app: string) {
  if (["google meet", "meet.google.com"].includes(app)) return "meet.google.com";
  if (["zoom", "zoom.us", "zoom workplace", "zoom.exe"].includes(app)) return "zoom.us";
  if (["microsoft teams", "teams", "ms-teams", "ms-teams.exe", "teams.exe"].includes(app)) {
    return "teams.microsoft.com";
  }
  return null;
}

function browserRoom(value: string | null | undefined, provider: string): string | null {
  if (!value) return null;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.protocol !== "https:") return null;
  const host = url.hostname;
  const path = url.pathname.replace(/\/$/, "");
  if (provider === "meet.google.com" && host === provider && /^\/[a-z]{3}-[a-z]{4}-[a-z]{3}$/i.test(path)) {
    return path.toLowerCase();
  }
  if (provider === "zoom.us" && (host === provider || host.endsWith(".zoom.us"))) {
    if (/^\/(?:j|wc(?:\/join)?)\/\d+(?:\/join)?$/.test(path)) {
      return path.split("/").find(part => /^\d+$/.test(part)) ?? null;
    }
    if (/^\/my\/[\w.-]+$/.test(path)) return path;
  }
  if (provider === "teams.microsoft.com" && host === provider) {
    if (/^\/l\/meetup-join\/[^/]+\/[^/]+$/.test(path)) return path;
    if (/^\/meet\/\d+$/.test(path)) return path;
  }
  return null;
}

function matchesTitle(windowName: string, title: string): boolean {
  if (!title) return false;
  return windowName === title || windowName.split(/\s+(?:[-–—|:]|·)\s+/).includes(title);
}

export async function findMeetingScreenRefs(
  meeting: MeetingWindow,
  limit: number,
  callAPI: (endpoint: string, options?: RequestInit) => Promise<Response>,
): Promise<ScreenRefs> {
  const empty = (status: ScreenRefs["screen_refs_status"]): ScreenRefs => ({
    screen_refs: [],
    screen_refs_status: status,
  });
  const app = normalize(meeting.meeting_app);
  const title = normalize(meeting.title);
  const provider = meetingProvider(app);
  const specificTitle = title.length >= 3 && !(
    title === app || meetingProvider(title) || ["meeting", "untitled meeting", "zoom meeting"].includes(title)
  ) ? title : "";
  const start = typeof meeting.meeting_start === "string" ? Date.parse(meeting.meeting_start) : NaN;
  const end = meeting.meeting_end == null ? Date.now()
    : typeof meeting.meeting_end === "string" ? Date.parse(meeting.meeting_end) : NaN;
  if (!app || app === "manual" || !(start < end) || (!provider && !specificTitle)) {
    return empty("no_match");
  }

  const params = new URLSearchParams({
    content_type: "ocr",
    start_time: new Date(start).toISOString(),
    end_time: new Date(end).toISOString(),
    limit: String(SEARCH_LIMIT),
    max_content_length: "1",
  });
  const signal = AbortSignal.timeout(LOOKUP_TIMEOUT_MS);
  const search = async (filter: Record<string, string>) => {
    const query = new URLSearchParams(params);
    for (const [key, value] of Object.entries(filter)) query.set(key, value);
    const response = await callAPI(`/search?${query}`, { signal });
    const page = await response.json() as SearchPage;
    if (!Array.isArray(page.data)) throw new Error("Invalid frame search response");
    return {
      complete: typeof page.pagination?.total === "number" && page.pagination.total <= page.data.length,
      frames: page.data
        .filter(item => item.type === "OCR" && item.content)
        .map(item => item.content)
        .filter(frame => {
          const time = Date.parse(frame.timestamp);
          return Number.isSafeInteger(frame.frame_id) && frame.frame_id > 0 && time >= start && time <= end;
        }),
    };
  };

  try {
    let matches: ScreenFrame[] = [];
    if (provider) {
      const page = await search({ browser_url: provider });
      const candidates = page.frames.flatMap(frame => {
        const room = browserRoom(frame.browser_url, provider);
        return room ? [{ frame, room }] : [];
      });
      const titleMatches = candidates.filter(({ frame, room }) =>
        matchesTitle(normalize(frame.window_name), specificTitle) || specificTitle === room.replace(/^\//, ""),
      );
      const rooms = new Set((titleMatches.length ? titleMatches : candidates).map(({ room }) => room));
      if (rooms.size > 1) return empty("ambiguous");
      if (rooms.size === 1 && (page.complete || titleMatches.length > 0)) {
        matches = candidates.filter(({ room }) => rooms.has(room)).map(({ frame }) => frame);
      } else if (!page.complete) {
        return empty("ambiguous");
      }
    }

    // A native client needs a matching app and specific window title. Generic
    // titles such as "Zoom Meeting" cannot identify an individual call.
    if (matches.length === 0 && specificTitle && provider !== "meet.google.com") {
      const appFilter = provider === "zoom.us" ? "zoom" : provider === "teams.microsoft.com" ? "teams" : app;
      const page = await search({ app_name: appFilter, window_name: specificTitle });
      matches = page.frames.filter(frame => {
        const capturedApp = normalize(frame.app_name);
        return (capturedApp === app || (provider && meetingProvider(capturedApp) === provider))
          && matchesTitle(normalize(frame.window_name), specificTitle);
      });
    }

    // Prefer accessibility-backed captures when the caller only needs one
    // frame. Stable sorting keeps the search API's recency order within each source.
    matches.sort((a, b) => Number(b.text_source === "accessibility") - Number(a.text_source === "accessibility"));
    const seen = new Set<number>();
    const screen_refs: ScreenRef[] = [];
    for (const frame of matches) {
      if (seen.has(frame.frame_id)) continue;
      seen.add(frame.frame_id);
      screen_refs.push({
        frame_id: frame.frame_id,
        timestamp: frame.timestamp,
        screenshot_uri: `screenpipe://frame/${frame.frame_id}`,
        text_source: frame.text_source === "accessibility" || frame.text_source === "ocr"
          ? frame.text_source : null,
      });
      if (screen_refs.length === limit) break;
    }
    return { screen_refs, screen_refs_status: screen_refs.length ? "matched" : "no_match" };
  } catch {
    return empty("unavailable");
  }
}
