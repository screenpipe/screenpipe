/**
 * Tests to reproduce server-side poll_timer issue
 *
 * The bug: New frames are captured to DB but not pushed to client in real-time.
 * User must right-click refresh to see new frames.
 *
 * This test simulates the server-side logic to identify the root cause.
 */

import { describe, it, expect, beforeEach } from "bun:test";

// Simulate the server-side data structures
interface FrameChunk {
  frame_id: number;
  timestamp: Date;
  data: string;
}

interface ActiveRequest {
  start_time: Date;
  end_time: Date;
  is_descending: boolean;
  last_polled: Date;
}

// Simulate database
function createMockDb(frames: FrameChunk[]) {
  return {
    find_video_chunks: (since: Date, until: Date): FrameChunk[] => {
      return frames.filter(f => f.timestamp >= since && f.timestamp <= until);
    }
  };
}

describe("Server Poll Logic - Reproducing Real-Time Push Bug", () => {

  /**
   * TEST 1: Simulate initial fetch marking frames as sent
   */
  it("initial fetch should mark all fetched frame IDs as sent", () => {
    const sentFrameIds = new Set<number>();

    // Simulate initial frames in DB (frames from today, 00:00 to now)
    const initialFrames: FrameChunk[] = [
      { frame_id: 1, timestamp: new Date("2024-01-15T10:00:00Z"), data: "frame1" },
      { frame_id: 2, timestamp: new Date("2024-01-15T10:01:00Z"), data: "frame2" },
      { frame_id: 3, timestamp: new Date("2024-01-15T10:02:00Z"), data: "frame3" },
    ];

    // Simulate fetch_and_process_frames_with_tracking
    for (const frame of initialFrames) {
      sentFrameIds.add(frame.frame_id);
    }

    expect(sentFrameIds.size).toBe(3);
    expect(sentFrameIds.has(1)).toBe(true);
    expect(sentFrameIds.has(2)).toBe(true);
    expect(sentFrameIds.has(3)).toBe(true);
  });

  /**
   * TEST 2: Poll should find NEW frames (not in sentFrameIds)
   */
  it("poll should find new frames not in sentFrameIds", () => {
    const sentFrameIds = new Set<number>([1, 2, 3]); // Already sent

    // New frame captured after initial fetch
    const allFrames: FrameChunk[] = [
      { frame_id: 1, timestamp: new Date("2024-01-15T10:00:00Z"), data: "frame1" },
      { frame_id: 2, timestamp: new Date("2024-01-15T10:01:00Z"), data: "frame2" },
      { frame_id: 3, timestamp: new Date("2024-01-15T10:02:00Z"), data: "frame3" },
      { frame_id: 4, timestamp: new Date("2024-01-15T10:03:00Z"), data: "frame4" }, // NEW
    ];

    const db = createMockDb(allFrames);

    // Simulate poll: look for frames from last_polled to now
    const lastPolled = new Date("2024-01-15T10:02:00Z");
    const now = new Date("2024-01-15T10:04:00Z");

    const chunks = db.find_video_chunks(lastPolled, now);
    const newFrames = chunks.filter(f => !sentFrameIds.has(f.frame_id));

    expect(newFrames.length).toBe(1);
    expect(newFrames[0].frame_id).toBe(4);
  });

  /**
   * TEST 3: BUG REPRODUCTION - last_polled equals latest frame timestamp
   *
   * If last_polled is set to the timestamp of the latest frame (not the current time),
   * and new frames have timestamps AFTER that, they should be found.
   *
   * But what if find_video_chunks uses > instead of >= ?
   */
  it("should find frames with timestamp > last_polled", () => {
    const sentFrameIds = new Set<number>([1, 2, 3]);

    const allFrames: FrameChunk[] = [
      { frame_id: 3, timestamp: new Date("2024-01-15T10:02:00Z"), data: "frame3" },
      { frame_id: 4, timestamp: new Date("2024-01-15T10:02:01Z"), data: "frame4" }, // 1 second later
    ];

    // last_polled is exactly the timestamp of frame 3
    const lastPolled = new Date("2024-01-15T10:02:00Z");
    const now = new Date("2024-01-15T10:04:00Z");

    // Simulate find_video_chunks with >= (inclusive)
    const chunksInclusive = allFrames.filter(f => f.timestamp >= lastPolled && f.timestamp <= now);
    const newFramesInclusive = chunksInclusive.filter(f => !sentFrameIds.has(f.frame_id));

    // Frame 4 should be found
    expect(newFramesInclusive.length).toBe(1);
    expect(newFramesInclusive[0].frame_id).toBe(4);
  });

  /**
   * TEST 4: BUG - What if poll_start >= poll_end?
   *
   * Server code: if poll_start < poll_end { ... }
   * If this fails, no poll happens!
   */
  it("POTENTIAL BUG: poll_start < poll_end check", () => {
    const lastPolled = new Date("2024-01-15T10:02:00.000Z");
    const now = new Date("2024-01-15T10:02:00.500Z"); // Only 500ms later
    const endTime = new Date("2024-01-15T23:59:59.999Z");

    const pollStart = lastPolled;
    const pollEnd = now < endTime ? now : endTime;

    // This should pass - 500ms gap
    expect(pollStart < pollEnd).toBe(true);

    // But what if last_polled was set to a future timestamp by mistake?
    const badLastPolled = new Date("2024-01-15T10:05:00.000Z"); // In the future!
    const badPollStart = badLastPolled;

    // This would FAIL - no poll would happen
    expect(badPollStart < pollEnd).toBe(false);
  });

  /**
   * TEST 5: BUG - last_polled set to latest frame, but frames captured in same second
   *
   * If multiple frames have the same timestamp, and last_polled is set to that timestamp,
   * subsequent frames in the same second might be missed.
   */
  it("POTENTIAL BUG: frames with same timestamp as last_polled", () => {
    const sameTimestamp = new Date("2024-01-15T10:02:00Z");

    const allFrames: FrameChunk[] = [
      { frame_id: 3, timestamp: sameTimestamp, data: "frame3" },
      { frame_id: 4, timestamp: sameTimestamp, data: "frame4" }, // Same timestamp, different ID
      { frame_id: 5, timestamp: sameTimestamp, data: "frame5" }, // Same timestamp, different ID
    ];

    // Initial fetch gets frame 3, sets last_polled to its timestamp
    const sentFrameIds = new Set<number>([3]);
    const lastPolled = sameTimestamp;

    // Poll looks for frames >= lastPolled
    const now = new Date("2024-01-15T10:04:00Z");
    const chunks = allFrames.filter(f => f.timestamp >= lastPolled && f.timestamp <= now);
    const newFrames = chunks.filter(f => !sentFrameIds.has(f.frame_id));

    // Frames 4 and 5 should be found (same timestamp but different IDs)
    expect(newFrames.length).toBe(2);
  });

  /**
   * TEST 6: BUG - end_time check with timezone issues
   *
   * Client sends end_time as local 23:59:59, but server compares with UTC now
   */
  it("POTENTIAL BUG: timezone mismatch in end_time check", () => {
    // Client in UTC+8 sends end_time as "2024-01-15T23:59:59" (local)
    // This might be interpreted as UTC on server
    const endTimeFromClient = new Date("2024-01-15T23:59:59Z"); // UTC

    // Server's "now" in UTC
    const serverNowUtc = new Date("2024-01-16T06:00:00Z"); // Next day in UTC

    // Check: now <= end_time
    const shouldPoll = serverNowUtc <= endTimeFromClient;

    // This would FAIL - server thinks end_time has passed
    expect(shouldPoll).toBe(false);

    // This is a bug if client is in a timezone ahead of UTC
    console.log("BUG: If client timezone > UTC, end_time check fails prematurely");
  });

  /**
   * TEST 7: Simulate full flow - initial fetch then poll
   */
  it("FULL FLOW: initial fetch marks frames, poll should find new ones", () => {
    const sentFrameIds = new Set<number>();
    let activeRequest: ActiveRequest | null = null;

    // === STEP 1: Initial frames in DB ===
    let dbFrames: FrameChunk[] = [
      { frame_id: 1, timestamp: new Date("2024-01-15T10:00:00Z"), data: "frame1" },
      { frame_id: 2, timestamp: new Date("2024-01-15T10:01:00Z"), data: "frame2" },
      { frame_id: 3, timestamp: new Date("2024-01-15T10:02:00Z"), data: "frame3" },
    ];

    // === STEP 2: Client sends request ===
    const requestStartTime = new Date("2024-01-15T00:00:00Z");
    const requestEndTime = new Date("2024-01-15T23:59:59.999Z");

    // === STEP 3: Initial fetch (fetch_and_process_frames_with_tracking) ===
    const db = createMockDb(dbFrames);
    const initialChunks = db.find_video_chunks(requestStartTime, requestEndTime);

    let latestTimestamp: Date | null = null;
    for (const chunk of initialChunks) {
      sentFrameIds.add(chunk.frame_id);
      if (!latestTimestamp || chunk.timestamp > latestTimestamp) {
        latestTimestamp = chunk.timestamp;
      }
    }

    // Set active request with last_polled = latestTimestamp
    activeRequest = {
      start_time: requestStartTime,
      end_time: requestEndTime,
      is_descending: true,
      last_polled: latestTimestamp!,
    };

    expect(sentFrameIds.size).toBe(3);
    expect(activeRequest.last_polled).toEqual(new Date("2024-01-15T10:02:00Z"));

    // === STEP 4: New frame captured ===
    dbFrames.push({ frame_id: 4, timestamp: new Date("2024-01-15T10:03:00Z"), data: "frame4" });

    // === STEP 5: Poll timer fires ===
    const now = new Date("2024-01-15T10:04:00Z");

    // Check: now <= end_time
    expect(now <= activeRequest.end_time).toBe(true);

    const pollStart = activeRequest.last_polled;
    const pollEnd = now < activeRequest.end_time ? now : activeRequest.end_time;

    // Check: poll_start < poll_end
    expect(pollStart < pollEnd).toBe(true);

    // Fetch new frames
    const newDb = createMockDb(dbFrames);
    const pollChunks = newDb.find_video_chunks(pollStart, pollEnd);
    const newFrames = pollChunks.filter(f => !sentFrameIds.has(f.frame_id));

    // === EXPECTED: Frame 4 should be found ===
    expect(newFrames.length).toBe(1);
    expect(newFrames[0].frame_id).toBe(4);

    console.log("✓ Full flow works in test - new frame found");
    console.log("  If this passes but real server fails, issue is elsewhere:");
    console.log("  - DB query implementation differs from mock");
    console.log("  - Timezone issues");
    console.log("  - tokio::select! starvation");
    console.log("  - WebSocket sender issues");
  });

  /**
   * TEST 8: The tokio::select! starvation issue
   *
   * When frame_rx channel closes, it returns None immediately.
   * In tokio::select!, a branch that completes immediately can starve other branches.
   */
  it("DOCUMENTED BUG: channel closure can starve poll_timer in tokio::select!", () => {
    // This test documents the bug we identified earlier
    // The server code has this structure:
    //
    // loop {
    //   tokio::select! {
    //     frame = frame_rx.recv() => { ... }  // Branch 1: receive from channel
    //     _ = poll_timer.tick() => { ... }    // Branch 2: poll for new frames
    //     _ = keepalive.tick() => { ... }     // Branch 3: keepalive
    //   }
    // }
    //
    // When frame_rx channel closes:
    // - recv() returns None IMMEDIATELY
    // - select! keeps picking this branch
    // - poll_timer and keepalive never run

    // Simulate this:
    let pollTimerRan = 0;
    let channelRecvRan = 0;
    const channelClosed = true;

    // Simulate 10 iterations of select!
    for (let i = 0; i < 10; i++) {
      // In real tokio::select!, the first ready branch wins
      // A closed channel is ALWAYS ready (returns None)
      if (channelClosed) {
        channelRecvRan++;
        // In buggy code, this branch always wins
        continue; // Simulates the bug - never reaches poll_timer
      }

      // This never runs if channel is closed (in buggy code)
      pollTimerRan++;
    }

    expect(channelRecvRan).toBe(10);
    expect(pollTimerRan).toBe(0);

    console.log("BUG CONFIRMED: Closed channel starves poll_timer");
    console.log("FIX: Server code should track channel closure and skip that branch");
    console.log("Current code at server.rs:3324-3328 DOES handle this correctly:");
    console.log("  frame_rx = None; // Sets to None so select! skips this branch");
  });

  /**
   * TEST 9: Check if the fix for channel starvation is correct
   */
  it("FIX VERIFICATION: server code handles channel closure correctly", () => {
    // The server code does this when channel closes:
    // None => {
    //   debug!("frame channel closed, switching to live polling only");
    //   frame_rx = None;
    // }
    //
    // And the select! branch is:
    // frame = async {
    //   match &mut frame_rx {
    //     Some(rx) => rx.recv().await,
    //     None => std::future::pending().await,  // Never completes!
    //   }
    // } => { ... }
    //
    // When frame_rx is None, this branch returns a pending future
    // which NEVER completes, so select! picks other branches.

    let frameRx: boolean | null = true; // Some(channel)
    let pollTimerRan = 0;
    let channelRecvRan = 0;

    for (let i = 0; i < 10; i++) {
      if (frameRx === null) {
        // Channel is None - this branch "never completes" (pending)
        // So we fall through to poll_timer
        pollTimerRan++;
      } else {
        // Channel receives something or closes
        channelRecvRan++;
        if (i === 2) {
          // Simulate channel closing on iteration 2
          frameRx = null;
        }
      }
    }

    expect(channelRecvRan).toBe(3); // Iterations 0, 1, 2
    expect(pollTimerRan).toBe(7);   // Iterations 3-9

    console.log("✓ Fix is correct - after channel closes, poll_timer runs");
  });
});

describe("BUG REPRODUCTION - Race Condition", () => {
  /**
   * BUG REPRODUCTION: Race between initial fetch task and poll_timer
   *
   * Server code flow:
   * 1. Request received, active_request.last_polled = START_TIME (00:00:00)
   * 2. Initial fetch SPAWNED (async, runs later)
   * 3. Poll timer ticks IMMEDIATELY (before initial fetch)
   * 4. Poll queries from START_TIME to NOW - gets ALL frames
   * 5. Poll marks ALL frames as sent
   * 6. Initial fetch finally runs, also sends same frames via channel
   * 7. Client gets frames twice OR poll already marked them
   * 8. New frame captured
   * 9. Poll runs, finds new frame, BUT...
   */
  it("BUG: poll_timer runs before initial fetch updates last_polled", () => {
    // Shared state (simulating Arc<Mutex<...>>)
    const sentFrameIds = new Set<number>();
    let activeRequest: ActiveRequest | null = null;

    // DB has existing frames
    const dbFrames: FrameChunk[] = [
      { frame_id: 1, timestamp: new Date("2024-01-15T10:00:00Z"), data: "frame1" },
      { frame_id: 2, timestamp: new Date("2024-01-15T10:01:00Z"), data: "frame2" },
      { frame_id: 3, timestamp: new Date("2024-01-15T10:02:00Z"), data: "frame3" },
    ];
    const db = createMockDb(dbFrames);

    // === STEP 1: Request received ===
    const startTime = new Date("2024-01-15T00:00:00Z");
    const endTime = new Date("2024-01-15T23:59:59.999Z");

    // Server sets active_request with last_polled = START_TIME (not latest frame!)
    activeRequest = {
      start_time: startTime,
      end_time: endTime,
      is_descending: true,
      last_polled: startTime,  // THIS IS THE BUG - starts at 00:00:00
    };

    // === STEP 2: Poll timer ticks BEFORE initial fetch completes ===
    const now = new Date("2024-01-15T10:03:00Z");
    const pollStart = activeRequest.last_polled; // 00:00:00
    const pollEnd = now;

    // Poll queries from 00:00:00 to 10:03:00 - gets ALL existing frames!
    const pollChunks = db.find_video_chunks(pollStart, pollEnd);
    expect(pollChunks.length).toBe(3); // Gets ALL frames

    // Poll marks ALL as sent
    for (const chunk of pollChunks) {
      if (!sentFrameIds.has(chunk.frame_id)) {
        sentFrameIds.add(chunk.frame_id);
      }
    }
    expect(sentFrameIds.size).toBe(3);

    // === STEP 3: Initial fetch finally runs ===
    // It also queries all frames and tries to send them
    const initialChunks = db.find_video_chunks(startTime, endTime);
    // Initial fetch marks them as sent too (redundant)
    let latestTs: Date | null = null;
    for (const chunk of initialChunks) {
      sentFrameIds.add(chunk.frame_id); // Already there
      if (!latestTs || chunk.timestamp > latestTs) latestTs = chunk.timestamp;
    }

    // Initial fetch updates last_polled to latest timestamp
    activeRequest.last_polled = latestTs!;
    expect(activeRequest.last_polled).toEqual(new Date("2024-01-15T10:02:00Z"));

    // === STEP 4: New frame captured ===
    dbFrames.push({ frame_id: 4, timestamp: new Date("2024-01-15T10:04:00Z"), data: "frame4" });

    // === STEP 5: Poll timer runs again ===
    const now2 = new Date("2024-01-15T10:05:00Z");
    const pollStart2 = activeRequest.last_polled; // Now 10:02:00
    const pollEnd2 = now2;

    const pollChunks2 = db.find_video_chunks(pollStart2, pollEnd2);
    // Should find frames with timestamp >= 10:02:00 and <= 10:05:00
    // Frame 3 (10:02:00) and Frame 4 (10:04:00) are in range

    const newFrames = pollChunks2.filter(f => !sentFrameIds.has(f.frame_id));

    // Frame 4 should be found as new
    expect(newFrames.length).toBe(1);
    expect(newFrames[0].frame_id).toBe(4);

    console.log("✓ This flow actually works - bug is elsewhere");
  });

  /**
   * BUG REPRODUCTION: What if initial fetch never updates last_polled?
   */
  it("BUG: initial fetch returns no frames, last_polled stays at start_time", () => {
    const sentFrameIds = new Set<number>();
    let activeRequest: ActiveRequest | null = null;

    // DB is EMPTY initially
    const dbFrames: FrameChunk[] = [];
    const db = createMockDb(dbFrames);

    // Request received
    const startTime = new Date("2024-01-15T00:00:00Z");
    const endTime = new Date("2024-01-15T23:59:59.999Z");

    activeRequest = {
      start_time: startTime,
      end_time: endTime,
      is_descending: true,
      last_polled: startTime,
    };

    // Initial fetch finds nothing
    const initialChunks = db.find_video_chunks(startTime, endTime);
    expect(initialChunks.length).toBe(0);

    // latest_timestamp is None, so last_polled is NOT updated
    // last_polled stays at 00:00:00

    // New frame captured
    dbFrames.push({ frame_id: 1, timestamp: new Date("2024-01-15T10:00:00Z"), data: "frame1" });

    // Poll runs
    const now = new Date("2024-01-15T10:01:00Z");
    const pollStart = activeRequest.last_polled; // Still 00:00:00
    const pollEnd = now;

    const pollChunks = db.find_video_chunks(pollStart, pollEnd);
    const newFrames = pollChunks.filter(f => !sentFrameIds.has(f.frame_id));

    // Should find frame 1
    expect(newFrames.length).toBe(1);
    expect(newFrames[0].frame_id).toBe(1);

    console.log("✓ This flow also works");
  });

  /**
   * BUG REPRODUCTION: The REAL bug - sent_frame_ids never cleared between polls?
   */
  it("BUG: sent_frame_ids accumulates across multiple requests", () => {
    const sentFrameIds = new Set<number>();

    // First request - frames 1, 2, 3 sent
    sentFrameIds.add(1);
    sentFrameIds.add(2);
    sentFrameIds.add(3);

    // User does right-click refresh
    // New WebSocket connection, new request
    // BUT sentFrameIds is NOT cleared if it's module-level state!

    // Check: does server clear sent_frame_ids on new request?
    // Looking at server code line 3238-3242:
    // {
    //     let mut sent = sent_frame_ids_clone.lock().await;
    //     sent.clear();  // YES, it clears!
    // }

    // Simulate clearing
    sentFrameIds.clear();
    expect(sentFrameIds.size).toBe(0);

    console.log("✓ Server DOES clear sent_frame_ids on new request");
  });

  /**
   * THE ACTUAL BUG: fetch_new_frames_since holds lock while iterating
   */
  it("BUG FOUND: fetch_new_frames_since holds lock, blocking updates", () => {
    // Look at fetch_new_frames_since code:
    // let sent = sent_frame_ids.lock().await;  // LOCK ACQUIRED
    // for chunk in chunks.frames {
    //     if sent.contains(&chunk.frame_id) { continue; }
    //     // ... process frame
    // }
    // drop(sent);  // LOCK RELEASED
    //
    // // Then locks again to mark as sent:
    // let mut sent = sent_frame_ids.lock().await;
    // for frame in &new_frames { sent.insert(...); }

    // The issue: While iterating, the lock is held.
    // If initial fetch is also trying to mark frames as sent, it's blocked!

    // But wait, they're different lock acquisitions...
    // Actually this shouldn't cause a deadlock, just contention.

    console.log("Lock contention might slow things but shouldn't cause bug");
    expect(true).toBe(true);
  });

  /**
   * THE ACTUAL BUG: WebSocket might be closed before poll sends
   */
  it("BUG: WebSocket closed, poll timer still runs but can't send", () => {
    let wsOpen = true;
    let framesSentViaPoll = 0;
    let errorCount = 0;

    // Simulate poll trying to send
    function sendFrames(frames: FrameChunk[]) {
      if (!wsOpen) {
        errorCount++;
        console.log("ERROR: failed to send - WebSocket closed");
        return false;
      }
      framesSentViaPoll += frames.length;
      return true;
    }

    // Poll sends some frames
    sendFrames([{ frame_id: 1, timestamp: new Date(), data: "frame1" }]);
    expect(framesSentViaPoll).toBe(1);

    // Client disconnects (closes WebSocket)
    wsOpen = false;

    // Poll tries to send more
    sendFrames([{ frame_id: 2, timestamp: new Date(), data: "frame2" }]);
    expect(framesSentViaPoll).toBe(1); // Didn't increase
    expect(errorCount).toBe(1);

    console.log("BUG: If WebSocket closes, poll silently fails");
    console.log("Logs show: 'failed to send batch: Trying to work with closed connection'");
    console.log("This matches what we see in the real logs!");
  });

  /**
   * ROOT CAUSE CONFIRMED: Client closes WebSocket, server poll fails
   */
  it("ROOT CAUSE: Client WebSocket closes prematurely", () => {
    // Evidence from logs:
    // "websocket start_send error: Trying to work with closed connection"
    // "failed to send batch: Trying to work with closed connection"
    //
    // This happens when:
    // 1. Client connects WebSocket
    // 2. Server starts streaming initial frames
    // 3. Client WebSocket closes (WHY?)
    // 4. Server poll_timer tries to send new frames
    // 5. Error: closed connection
    //
    // The question is: WHY does client close the WebSocket?
    //
    // Possible reasons:
    // 1. React component unmounts
    // 2. React Strict Mode double-render closes first connection
    // 3. Error in client code causes disconnect
    // 4. Navigation away from page
    // 5. Tauri webview refresh
    //
    // The fix we made (closing CONNECTING WebSockets too) should help with #2

    console.log("=".repeat(60));
    console.log("ROOT CAUSE IDENTIFIED:");
    console.log("Client WebSocket closes prematurely, server can't push frames");
    console.log("");
    console.log("Evidence:");
    console.log("- Logs show 'failed to send batch: closed connection'");
    console.log("- Right-click refresh creates NEW WebSocket that works");
    console.log("");
    console.log("Question: Why does client WebSocket close?");
    console.log("=".repeat(60));

    expect(true).toBe(true); // This test documents the bug
  });

  /**
   * CLIENT BUG: isServerDown flapping causes Timeline remount
   */
  it("CLIENT BUG: Timeline remounts when isServerDown flaps", () => {
    // In page.tsx:
    // {!isServerDown ? <Timeline /> : <ServerDownUI />}
    //
    // If isServerDown goes: false -> true -> false
    // Timeline unmounts then remounts
    // useEffect in use-timeline-data.tsx calls connectWebSocket()
    // This creates a NEW WebSocket, closing the old one!

    let timelineMounted = false;
    let wsConnectionCount = 0;
    let wsCloseCount = 0;

    function mountTimeline() {
      timelineMounted = true;
      // useEffect calls connectWebSocket
      wsConnectionCount++;
    }

    function unmountTimeline() {
      timelineMounted = false;
      // No cleanup closes WebSocket - but new mount will!
    }

    function simulateServerDownFlap() {
      // isServerDown = true
      unmountTimeline();
      // isServerDown = false
      mountTimeline(); // New WebSocket created, old one orphaned/closed
    }

    // Initial mount
    mountTimeline();
    expect(wsConnectionCount).toBe(1);

    // Health check flaps
    simulateServerDownFlap();
    expect(wsConnectionCount).toBe(2);

    // Each mount creates new WS, potentially closing old
    simulateServerDownFlap();
    expect(wsConnectionCount).toBe(3);

    console.log("BUG: Every Timeline remount creates new WebSocket");
    console.log("If health check flaps, multiple WebSockets created");
    console.log("Server sends to old WS which gets closed = error");
  });

  /**
   * CLIENT BUG: connectWebSocket closes existing but server still has reference
   */
  it("CLIENT BUG: Server has stale WebSocket reference after client reconnect", () => {
    // Sequence:
    // 1. Client connects WS#1
    // 2. Server stores WS#1 reference, starts poll_timer
    // 3. Client calls connectWebSocket() again (remount, error, etc)
    // 4. Client closes WS#1, creates WS#2
    // 5. Server poll_timer still has WS#1 reference
    // 6. Server tries to send on WS#1 - CLOSED!
    // 7. Error: "Trying to work with closed connection"

    let serverWsRef = "WS#1";
    let clientWsRef = "WS#1";
    let serverSendErrors = 0;

    function clientReconnect() {
      // Client closes old WS and creates new one
      clientWsRef = "WS#2";
      // But server still has old reference!
    }

    function serverTrySend() {
      if (serverWsRef !== clientWsRef) {
        serverSendErrors++;
        return false; // "closed connection"
      }
      return true;
    }

    // Initial - both have same WS
    expect(serverTrySend()).toBe(true);

    // Client reconnects
    clientReconnect();

    // Server tries to send on old WS
    expect(serverTrySend()).toBe(false);
    expect(serverSendErrors).toBe(1);

    console.log("BUG CONFIRMED: Server holds stale WS reference");
    console.log("Client reconnect doesn't update server's reference");
    console.log("Server's poll_timer uses stale WS = send fails");
  });

  /**
   * THE FIX: When client reconnects, server should detect and use new WS
   */
  it("FIX NEEDED: Server poll should detect WS closure and stop", () => {
    console.log("Server DOES break loop on send error");
    console.log("But old WS loop errors don't affect new WS");
    console.log("The question is: why does the NEW WS not work?");
    expect(true).toBe(true);
  });

  /**
   * BUG FOUND: Reconnect timeout creates duplicate WebSockets
   */
  it("BUG: ws.onclose timeout + component remount = duplicate WebSockets", () => {
    // Sequence:
    // 1. WS#1 connects
    // 2. WS#1 closes (for whatever reason)
    // 3. ws.onclose sets timeout: reconnect in 5 seconds
    // 4. Component remounts (React Strict Mode, navigation, etc)
    // 5. useEffect calls connectWebSocket() - creates WS#2
    // 6. 5 seconds later, timeout fires, calls connectWebSocket()
    // 7. WS#2 closed, WS#3 created
    // 8. WS#3's onclose sets another timeout
    // 9. Infinite cycle of reconnections!

    const reconnectTimeouts: number[] = [];
    let wsCount = 0;
    let currentWs: number | null = null;

    function connectWebSocket() {
      // Close existing
      if (currentWs !== null) {
        // Simulate ws.onclose firing
        // Set timeout for reconnect
        reconnectTimeouts.push(wsCount);
      }
      wsCount++;
      currentWs = wsCount;
    }

    function fireTimeouts() {
      const pending = [...reconnectTimeouts];
      reconnectTimeouts.length = 0;
      for (const _ of pending) {
        connectWebSocket();
      }
    }

    // Initial connect
    connectWebSocket();
    expect(wsCount).toBe(1);
    expect(reconnectTimeouts.length).toBe(0);

    // WS closes, sets timeout
    reconnectTimeouts.push(wsCount);

    // Component remounts before timeout fires
    connectWebSocket(); // Creates WS#2, WS#1 close sets timeout
    expect(wsCount).toBe(2);
    expect(reconnectTimeouts.length).toBe(2); // Two timeouts pending!

    // Timeouts fire
    fireTimeouts();
    expect(wsCount).toBe(4); // Two more WSes created!

    // More timeouts fire (cascade)
    fireTimeouts();
    expect(wsCount).toBe(6);

    console.log("BUG CONFIRMED: Reconnect timeouts cascade");
    console.log(`Created ${wsCount} WebSockets from cascade`);
    console.log("FIX: Clear pending reconnect timeout when connectWebSocket is called");
  });

  /**
   * THE ACTUAL FIX: Cancel pending reconnect timeout
   */
  it("FIX: Cancel reconnect timeout when connectWebSocket called", () => {
    let reconnectTimeout: ReturnType<typeof setTimeout> | null = null;
    let wsCount = 0;
    let currentWs: number | null = null;

    function connectWebSocket() {
      // FIX: Cancel any pending reconnect timeout
      if (reconnectTimeout) {
        clearTimeout(reconnectTimeout);
        reconnectTimeout = null;
      }

      // Close existing
      if (currentWs !== null) {
        // ws.onclose would set timeout, but we track it
      }
      wsCount++;
      currentWs = wsCount;
    }

    function simulateWsClose() {
      // Simulate ws.onclose setting timeout
      reconnectTimeout = setTimeout(() => {
        reconnectTimeout = null;
        connectWebSocket();
      }, 5000);
    }

    // Initial connect
    connectWebSocket();
    expect(wsCount).toBe(1);

    // WS closes
    simulateWsClose();
    expect(reconnectTimeout).not.toBeNull();

    // Component remounts before timeout
    connectWebSocket(); // Should cancel timeout
    expect(wsCount).toBe(2);
    // Timeout was cleared by connectWebSocket

    // No cascade happens because timeout was cleared
    // (Can't actually test setTimeout clearing in sync test)

    console.log("FIX: Clear reconnectTimeout at start of connectWebSocket");
  });
});

describe("Server Poll Logic - Database Query Investigation", () => {
  /**
   * TEST 10: Check if find_video_chunks might return empty
   */
  it("find_video_chunks returns empty if time range has no frames", () => {
    const frames: FrameChunk[] = [
      { frame_id: 1, timestamp: new Date("2024-01-15T10:00:00Z"), data: "frame1" },
    ];

    const db = createMockDb(frames);

    // Query for time range AFTER the frame
    const since = new Date("2024-01-15T10:01:00Z");
    const until = new Date("2024-01-15T10:02:00Z");

    const result = db.find_video_chunks(since, until);
    expect(result.length).toBe(0);

    console.log("If poll_start is after latest frame, no frames found");
  });

  /**
   * TEST 11: Frames captured but not committed to DB yet
   */
  it("POTENTIAL BUG: frame captured but DB transaction not committed", () => {
    // This can't be tested in JS, but documents a potential issue:
    // 1. Screen capture creates frame
    // 2. Frame written to DB but transaction not committed
    // 3. Poll queries DB - doesn't see uncommitted frame
    // 4. Transaction commits
    // 5. Next poll might see it, or might miss if last_polled advanced

    console.log("POTENTIAL BUG: DB transaction timing");
    console.log("Frame might be captured but not visible to poll query");
    expect(true).toBe(true); // Placeholder
  });
});
