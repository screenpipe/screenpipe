// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com

// Run against an E2E build in a disposable VM after real capture has started.
// Both URLs must be supplied explicitly; never discover or stop a host app.
import assert from "node:assert/strict";

const control = process.env.SCREENPIPE_SEARCH_TEST_CONTROL_URL;
const api = process.env.SCREENPIPE_SEARCH_TEST_API_URL;
assert(
  control && api,
  "Set both SCREENPIPE_SEARCH_TEST_CONTROL_URL and SCREENPIPE_SEARCH_TEST_API_URL for the disposable app",
);
const headers: Record<string, string> = { "content-type": "application/json" };
if (process.env.SCREENPIPE_SEARCH_TEST_API_KEY) {
  headers.authorization = `Bearer ${process.env.SCREENPIPE_SEARCH_TEST_API_KEY}`;
}
type State = {
  pid: number;
  search_only: boolean;
  entering: boolean;
  capture_intended: boolean;
  capture_running: boolean;
  webviews: string[];
  keep_search_after_quit: boolean;
};
async function request(
  base: string,
  route: string,
  method = "GET",
  body?: unknown,
) {
  const res = await fetch(base + route, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(45_000),
  });
  assert(res.ok, `${method} ${route}: ${res.status}`);
  return res.json();
}
const state = (): Promise<State> => request(control, "/e2e/search-only/state");
async function until(check: () => Promise<boolean>, label: string) {
  const deadline = Date.now() + 45_000;
  do {
    if (await check()) return;
    await Bun.sleep(300);
  } while (Date.now() < deadline);
  throw new Error(`Timed out: ${label}`);
}
const historySnapshot = () => request(api, "/search?limit=1&content_type=all");
const counts = async () => {
  // Use the caller's authorized history view: free accounts intentionally
  // cannot use unrestricted raw SQL. Runtime counters cover UI capture too.
  const [history, health] = await Promise.all([
    historySnapshot(),
    request(api, "/health"),
  ]);
  return {
    history,
    framesWritten: health.pipeline?.frames_db_written,
    uiEvents: health.ui_recorder?.events_inserted,
    lastAudio: health.last_audio_timestamp,
  };
};

const initial = await state();
assert(initial.keep_search_after_quit, "The preference defaults On");
assert(
  initial.capture_intended && initial.capture_running,
  "Start real capture before running this check",
);
const history = await request(api, "/search?limit=1&content_type=all");
assert(
  history.data?.length > 0,
  "Capture must produce searchable history before Quit",
);

for (let cycle = 0; cycle < 2; cycle++) {
  await request(control, "/e2e/search-only/quit", "POST");
  await until(async () => {
    const s = await state();
    return (
      s.search_only &&
      !s.entering &&
      !s.capture_intended &&
      !s.capture_running &&
      s.webviews.length === 0
    );
  }, "Quit stops capture and destroys webviews");
  assert.equal(
    (await state()).pid,
    initial.pid,
    "Quit must retain the existing process",
  );
  assert(
    (await request(api, "/search?limit=1&content_type=all")).data.length > 0,
    "External history request succeeds after Quit",
  );
  const stopped = await counts();
  await Bun.sleep(5_000);
  assert.deepEqual(
    await counts(),
    stopped,
    "No new screen, audio, or UI captures after Quit",
  );
  for (const route of [
    "/audio/start",
    "/vision/device/start",
    "/capture/hd/start",
    "/pipes/example/run",
  ]) {
    const res = await fetch(api + route, {
      method: "POST",
      headers,
      body: "{}",
    });
    assert.equal(
      res.status,
      409,
      `${route} cannot resume capture or background work`,
    );
    assert.equal((await res.json()).error, "search_only");
  }
  await request(control, "/e2e/search-only/reopen", "POST");
  await until(
    async () => (await state()).webviews.includes("home"),
    "Reopen shows Home",
  );
  const reopened = await state();
  assert.equal(reopened.pid, initial.pid);
  assert(
    !reopened.capture_running && !reopened.capture_intended,
    "Reopen must leave capture paused",
  );
  assert(
    (await request(control, "/e2e/search-only/resume", "POST")).resumed,
    "Explicit resume works",
  );
  await until(
    async () => (await state()).capture_running,
    "Recording resumes explicitly",
  );
}

await request(control, "/e2e/search-only/quit", "POST");
await until(async () => {
  const s = await state();
  return s.search_only && !s.entering && !s.capture_running;
}, "Quit before updater relaunch");
const beforeRestart = await historySnapshot();
await request(control, "/e2e/search-only/restart", "POST");
await until(async () => {
  try {
    const s = await state();
    return (
      s.pid !== initial.pid &&
      s.search_only &&
      !s.capture_running &&
      !s.capture_intended &&
      s.webviews.length === 0
    );
  } catch {
    return false;
  }
}, "Updater relaunch preserves hidden UI and stopped capture");
await until(async () => {
  try {
    return (
      (await request(api, "/search?limit=1&content_type=all")).data.length > 0
    );
  } catch {
    return false;
  }
}, "Search returns after updater relaunch");
assert.deepEqual(
  await historySnapshot(),
  beforeRestart,
  "Relaunch creates no captures",
);
console.log(
  "PASS: two Quit/search/reopen/resume cycles, same PID, stable capture counts, blocked mutations, updater relaunch restores search with recording paused",
);
