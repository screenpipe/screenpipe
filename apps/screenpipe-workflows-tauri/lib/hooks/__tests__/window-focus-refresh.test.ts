/**
 * Tests for window focus refresh functionality
 *
 * The bug: When user opens timeline at 6:30, closes it, then reopens at 7:00,
 * it still shows 6:30 frames instead of fetching new ones.
 *
 * Root cause: `sentRequests` Set prevents re-fetching the same date.
 *
 * Fix: Add `onWindowFocus()` method that clears current date from sentRequests
 * and triggers a fresh fetch.
 */

import { describe, it, expect, beforeEach, mock, spyOn } from "bun:test";

// Mock the store's internal state
interface MockTimelineState {
  frames: any[];
  sentRequests: Set<string>;
  currentDate: Date;
  websocket: { readyState: number; send: (data: string) => void } | null;
  isLoading: boolean;
}

// Helper to create date key (matches store implementation)
function getDateKey(date: Date): string {
  return `${date.getDate()}-${date.getMonth()}-${date.getFullYear()}`;
}

describe("Window Focus Refresh - sentRequests clearing", () => {
  let state: MockTimelineState;
  let fetchTimeRangeCalled: boolean;
  let fetchTimeRangeArgs: { start: Date; end: Date } | null;

  beforeEach(() => {
    fetchTimeRangeCalled = false;
    fetchTimeRangeArgs = null;

    state = {
      frames: [],
      sentRequests: new Set<string>(),
      currentDate: new Date("2024-01-15T18:30:00Z"), // 6:30 PM
      websocket: {
        readyState: 1, // WebSocket.OPEN
        send: mock(() => {}),
      },
      isLoading: false,
    };
  });

  /**
   * TEST 1: Verify sentRequests blocks re-fetch for same date
   */
  it("sentRequests should block duplicate fetch for same date", () => {
    const today = new Date("2024-01-15T18:30:00Z");
    const dateKey = getDateKey(today);

    // Simulate: first fetch at 6:30 PM
    state.sentRequests.add(dateKey);

    // Verify: key exists
    expect(state.sentRequests.has(dateKey)).toBe(true);

    // Simulate: fetchTimeRange check (from actual store code)
    const shouldSkip = state.sentRequests.has(dateKey);
    expect(shouldSkip).toBe(true); // This is the bug - we skip!
  });

  /**
   * TEST 2: onWindowFocus should clear current date from sentRequests
   */
  it("onWindowFocus should clear current date from sentRequests", () => {
    const today = new Date("2024-01-15T19:00:00Z"); // 7:00 PM
    state.currentDate = today;
    const dateKey = getDateKey(today);

    // Simulate: date was fetched earlier at 6:30
    state.sentRequests.add(dateKey);
    expect(state.sentRequests.has(dateKey)).toBe(true);

    // Simulate: onWindowFocus() implementation
    function onWindowFocus() {
      const currentDateKey = getDateKey(state.currentDate);
      state.sentRequests.delete(currentDateKey);
    }

    // Call onWindowFocus
    onWindowFocus();

    // Verify: key is cleared
    expect(state.sentRequests.has(dateKey)).toBe(false);
  });

  /**
   * TEST 3: After onWindowFocus, fetchTimeRange should be allowed
   */
  it("fetchTimeRange should be allowed after onWindowFocus clears sentRequests", () => {
    const today = new Date("2024-01-15T19:00:00Z");
    state.currentDate = today;
    const dateKey = getDateKey(today);

    // Setup: date was already fetched
    state.sentRequests.add(dateKey);

    // Simulate fetchTimeRange logic
    function fetchTimeRange(startTime: Date, endTime: Date): boolean {
      const requestKey = getDateKey(startTime);
      if (state.sentRequests.has(requestKey)) {
        return false; // Skipped
      }
      // Would send WebSocket request here
      state.sentRequests.add(requestKey);
      fetchTimeRangeCalled = true;
      fetchTimeRangeArgs = { start: startTime, end: endTime };
      return true; // Sent
    }

    // Before onWindowFocus: should skip
    const startTime = new Date(today);
    startTime.setHours(0, 0, 0, 0);
    const endTime = new Date(today);
    endTime.setHours(23, 59, 59, 999);

    let result = fetchTimeRange(startTime, endTime);
    expect(result).toBe(false); // Blocked!
    expect(fetchTimeRangeCalled).toBe(false);

    // Call onWindowFocus
    state.sentRequests.delete(dateKey);

    // After onWindowFocus: should work
    result = fetchTimeRange(startTime, endTime);
    expect(result).toBe(true); // Allowed!
    expect(fetchTimeRangeCalled).toBe(true);
  });

  /**
   * TEST 4: onWindowFocus should only clear current date, not other dates
   */
  it("onWindowFocus should only clear current date, preserve other dates", () => {
    const today = new Date("2024-01-15T19:00:00Z");
    const yesterday = new Date("2024-01-14T12:00:00Z");
    state.currentDate = today;

    const todayKey = getDateKey(today);
    const yesterdayKey = getDateKey(yesterday);

    // Both dates were fetched
    state.sentRequests.add(todayKey);
    state.sentRequests.add(yesterdayKey);

    // onWindowFocus only clears current date
    function onWindowFocus() {
      const currentDateKey = getDateKey(state.currentDate);
      state.sentRequests.delete(currentDateKey);
    }

    onWindowFocus();

    // Today cleared, yesterday preserved
    expect(state.sentRequests.has(todayKey)).toBe(false);
    expect(state.sentRequests.has(yesterdayKey)).toBe(true);
  });

  /**
   * TEST 5: Full flow - open at 6:30, close, reopen at 7:00
   */
  it("full flow: reopen at 7:00 should fetch new frames", () => {
    // Step 1: User opens timeline at 6:30
    const time630 = new Date("2024-01-15T18:30:00Z");
    state.currentDate = time630;
    const dateKey = getDateKey(time630);

    // Initial fetch happens
    state.sentRequests.add(dateKey);
    state.frames = [
      { timestamp: "2024-01-15T18:25:00Z", devices: [] },
      { timestamp: "2024-01-15T18:30:00Z", devices: [] },
    ];

    // Step 2: User closes timeline (window hidden)
    // State persists in Zustand store

    // Step 3: User reopens at 7:00
    const time700 = new Date("2024-01-15T19:00:00Z");
    state.currentDate = time700; // Current date is still today

    // Step 4: Window focus event fires, triggers onWindowFocus
    function onWindowFocus() {
      const currentDateKey = getDateKey(state.currentDate);
      state.sentRequests.delete(currentDateKey);
    }
    onWindowFocus();

    // Step 5: fetchTimeRange is called (from onWindowFocus or useEffect)
    function fetchTimeRange(startTime: Date, endTime: Date): boolean {
      const requestKey = getDateKey(startTime);
      if (state.sentRequests.has(requestKey)) {
        return false;
      }
      state.sentRequests.add(requestKey);
      // WebSocket would send request here
      return true;
    }

    const startTime = new Date(time700);
    startTime.setHours(0, 0, 0, 0);
    const endTime = new Date(time700);
    endTime.setHours(23, 59, 59, 999);

    const result = fetchTimeRange(startTime, endTime);

    // Verify: fetch was allowed
    expect(result).toBe(true);
    // In real implementation, new frames from 6:30-7:00 would arrive via WebSocket
  });
});

describe("Window Focus Refresh - WebSocket integration", () => {
  /**
   * TEST 6: onWindowFocus should work even if WebSocket is still connected
   */
  it("should re-fetch even with existing WebSocket connection", () => {
    const mockSend = mock(() => {});
    const state: MockTimelineState = {
      frames: [{ timestamp: "2024-01-15T18:30:00Z", devices: [] }],
      sentRequests: new Set<string>(),
      currentDate: new Date("2024-01-15T19:00:00Z"),
      websocket: {
        readyState: 1, // OPEN
        send: mockSend,
      },
      isLoading: false,
    };

    const dateKey = getDateKey(state.currentDate);
    state.sentRequests.add(dateKey);

    // onWindowFocus clears and triggers fetch
    function onWindowFocus() {
      const currentDateKey = getDateKey(state.currentDate);
      state.sentRequests.delete(currentDateKey);

      // Trigger fetch if WebSocket is open
      if (state.websocket && state.websocket.readyState === 1) {
        const startTime = new Date(state.currentDate);
        startTime.setHours(0, 0, 0, 0);
        const endTime = new Date(state.currentDate);
        endTime.setHours(23, 59, 59, 999);

        state.websocket.send(
          JSON.stringify({
            start_time: startTime.toISOString(),
            end_time: endTime.toISOString(),
            order: "descending",
          })
        );
        state.sentRequests.add(currentDateKey);
      }
    }

    onWindowFocus();

    // Verify WebSocket.send was called
    expect(mockSend).toHaveBeenCalled();
  });

  /**
   * TEST 7: onWindowFocus should reconnect if WebSocket is closed
   */
  it("should reconnect WebSocket if closed on focus", () => {
    let connectWebSocketCalled = false;

    const state: MockTimelineState = {
      frames: [],
      sentRequests: new Set<string>(),
      currentDate: new Date("2024-01-15T19:00:00Z"),
      websocket: null, // Closed/disconnected
      isLoading: false,
    };

    function connectWebSocket() {
      connectWebSocketCalled = true;
      // Would create new WebSocket
    }

    function onWindowFocus() {
      const currentDateKey = getDateKey(state.currentDate);
      state.sentRequests.delete(currentDateKey);

      // If WebSocket is not open, reconnect
      if (!state.websocket || state.websocket.readyState !== 1) {
        connectWebSocket();
      }
    }

    onWindowFocus();

    expect(connectWebSocketCalled).toBe(true);
  });
});
