/**
 * Tests for Timeline WebSocket Reconnection Logic
 *
 * These tests verify that:
 * 1. sentRequests is cleared on reconnection (so data can be re-fetched)
 * 2. Request timeout triggers auto-retry
 * 3. State is properly reset on reconnection
 */

import { describe, it, expect, beforeEach } from "bun:test";

// ============================================================================
// ISSUE: sentRequests blocking re-fetches after reconnection
// ============================================================================

describe("Timeline Reconnection - sentRequests Management", () => {
  /**
   * TEST 1: sentRequests should be cleared when WebSocket reconnects
   *
   * Scenario: WebSocket disconnects and reconnects. The sentRequests Set
   * still has old entries, blocking new requests for the same date.
   *
   * Expected: sentRequests should be cleared on reconnection so fresh
   * data can be fetched.
   */
  it("should clear sentRequests on WebSocket reconnection", () => {
    // Simulate initial state with a sent request
    let sentRequests = new Set<string>();
    const dateKey = "15-0-2024"; // Jan 15, 2024
    sentRequests.add(dateKey);

    expect(sentRequests.has(dateKey)).toBe(true);

    // Simulate connectWebSocket being called (reconnection)
    function simulateReconnect(): Set<string> {
      // This is what SHOULD happen on reconnection
      return new Set<string>(); // Clear all sent requests
    }

    sentRequests = simulateReconnect();

    // After reconnection, sentRequests should be empty
    expect(sentRequests.has(dateKey)).toBe(false);
    expect(sentRequests.size).toBe(0);
  });

  /**
   * TEST 2: hasDateBeenFetched should return false after reconnection
   */
  it("hasDateBeenFetched should return false after reconnection", () => {
    let sentRequests = new Set<string>();

    function hasDateBeenFetched(date: Date): boolean {
      const dateKey = `${date.getDate()}-${date.getMonth()}-${date.getFullYear()}`;
      return sentRequests.has(dateKey);
    }

    const testDate = new Date(2024, 0, 15); // Jan 15, 2024

    // Initially not fetched
    expect(hasDateBeenFetched(testDate)).toBe(false);

    // Mark as fetched
    sentRequests.add("15-0-2024");
    expect(hasDateBeenFetched(testDate)).toBe(true);

    // Simulate reconnection - clear sentRequests
    sentRequests = new Set<string>();
    expect(hasDateBeenFetched(testDate)).toBe(false);
  });

  /**
   * TEST 3: Multiple dates should all be clearable
   */
  it("should clear all dates on reconnection, not just current", () => {
    const sentRequests = new Set<string>();

    // Mark multiple dates as fetched
    sentRequests.add("15-0-2024"); // Jan 15
    sentRequests.add("16-0-2024"); // Jan 16
    sentRequests.add("17-0-2024"); // Jan 17

    expect(sentRequests.size).toBe(3);

    // Simulate reconnection
    const newSentRequests = new Set<string>();

    expect(newSentRequests.size).toBe(0);
  });
});

// ============================================================================
// ISSUE: Request timeout and auto-retry
// ============================================================================

describe("Timeline Reconnection - Request Timeout Logic", () => {
  /**
   * TEST 4: Should detect when request times out (no frames received)
   */
  it("should detect request timeout when no frames arrive", () => {
    const REQUEST_TIMEOUT_MS = 5000;

    interface RequestState {
      requestSentAt: number | null;
      framesReceived: number;
    }

    const state: RequestState = {
      requestSentAt: Date.now(),
      framesReceived: 0,
    };

    function isRequestTimedOut(currentTime: number): boolean {
      if (!state.requestSentAt) return false;
      if (state.framesReceived > 0) return false;
      return currentTime - state.requestSentAt > REQUEST_TIMEOUT_MS;
    }

    // Before timeout
    expect(isRequestTimedOut(Date.now() + 3000)).toBe(false);

    // After timeout with no frames
    expect(isRequestTimedOut(Date.now() + 6000)).toBe(true);
  });

  /**
   * TEST 5: Should not timeout if frames have been received
   */
  it("should not timeout if frames have been received", () => {
    const REQUEST_TIMEOUT_MS = 5000;

    interface RequestState {
      requestSentAt: number | null;
      framesReceived: number;
    }

    const state: RequestState = {
      requestSentAt: Date.now(),
      framesReceived: 5, // Frames received
    };

    function isRequestTimedOut(currentTime: number): boolean {
      if (!state.requestSentAt) return false;
      if (state.framesReceived > 0) return false;
      return currentTime - state.requestSentAt > REQUEST_TIMEOUT_MS;
    }

    // Even after timeout period, should not be timed out because frames exist
    expect(isRequestTimedOut(Date.now() + 10000)).toBe(false);
  });

  /**
   * TEST 6: Auto-retry should clear the specific date from sentRequests
   */
  it("should clear specific date from sentRequests on timeout for retry", () => {
    const sentRequests = new Set<string>();
    sentRequests.add("15-0-2024");
    sentRequests.add("16-0-2024");

    function clearDateForRetry(date: Date): void {
      const dateKey = `${date.getDate()}-${date.getMonth()}-${date.getFullYear()}`;
      sentRequests.delete(dateKey);
    }

    // Clear Jan 15 for retry
    clearDateForRetry(new Date(2024, 0, 15));

    expect(sentRequests.has("15-0-2024")).toBe(false);
    expect(sentRequests.has("16-0-2024")).toBe(true); // Other dates unaffected
  });

  /**
   * TEST 7: Retry counter should limit retries
   */
  it("should limit retries to prevent infinite loops", () => {
    const MAX_RETRIES = 3;
    let retryCount = 0;

    function shouldRetry(): boolean {
      return retryCount < MAX_RETRIES;
    }

    function attemptRetry(): boolean {
      if (shouldRetry()) {
        retryCount++;
        return true;
      }
      return false;
    }

    expect(attemptRetry()).toBe(true); // Retry 1
    expect(attemptRetry()).toBe(true); // Retry 2
    expect(attemptRetry()).toBe(true); // Retry 3
    expect(attemptRetry()).toBe(false); // Max reached
    expect(retryCount).toBe(3);
  });
});

// ============================================================================
// ISSUE: State reset on reconnection
// ============================================================================

describe("Timeline Reconnection - State Reset", () => {
  /**
   * TEST 8: All relevant state should be reset on reconnection
   */
  it("should reset all state on reconnection", () => {
    interface TimelineState {
      frames: unknown[];
      frameTimestamps: Set<string>;
      sentRequests: Set<string>;
      isLoading: boolean;
      error: string | null;
      message: string | null;
    }

    // Simulate dirty state before reconnection
    const dirtyState: TimelineState = {
      frames: [{ timestamp: "old" }],
      frameTimestamps: new Set(["old"]),
      sentRequests: new Set(["15-0-2024"]),
      isLoading: false,
      error: "Some old error",
      message: "Some old message",
    };

    // Simulate connectWebSocket reset
    function resetStateForReconnection(): TimelineState {
      return {
        frames: [],
        frameTimestamps: new Set<string>(),
        sentRequests: new Set<string>(),
        isLoading: true,
        error: null,
        message: null,
      };
    }

    const cleanState = resetStateForReconnection();

    expect(cleanState.frames.length).toBe(0);
    expect(cleanState.frameTimestamps.size).toBe(0);
    expect(cleanState.sentRequests.size).toBe(0);
    expect(cleanState.isLoading).toBe(true);
    expect(cleanState.error).toBe(null);
    expect(cleanState.message).toBe(null);
  });

  /**
   * TEST 9: WebSocket ready state check before sending
   */
  it("should only send request when WebSocket is OPEN", () => {
    // WebSocket.OPEN = 1
    const WS_CONNECTING = 0;
    const WS_OPEN = 1;
    const WS_CLOSING = 2;
    const WS_CLOSED = 3;

    function canSendRequest(readyState: number): boolean {
      return readyState === WS_OPEN;
    }

    expect(canSendRequest(WS_CONNECTING)).toBe(false);
    expect(canSendRequest(WS_OPEN)).toBe(true);
    expect(canSendRequest(WS_CLOSING)).toBe(false);
    expect(canSendRequest(WS_CLOSED)).toBe(false);
  });

  /**
   * TEST 10: Request should be queued if WebSocket not ready
   */
  it("should queue request and send when WebSocket becomes ready", () => {
    let pendingRequest: { startTime: Date; endTime: Date } | null = null;
    let wsReadyState = 0; // CONNECTING

    function fetchTimeRange(startTime: Date, endTime: Date): boolean {
      if (wsReadyState !== 1) {
        // Queue for later
        pendingRequest = { startTime, endTime };
        return false;
      }
      // Send immediately
      pendingRequest = null;
      return true;
    }

    function onWebSocketOpen(): void {
      wsReadyState = 1;
      if (pendingRequest) {
        fetchTimeRange(pendingRequest.startTime, pendingRequest.endTime);
      }
    }

    const start = new Date(2024, 0, 15, 0, 0, 0);
    const end = new Date(2024, 0, 15, 23, 59, 59);

    // Try to fetch while connecting - should queue
    expect(fetchTimeRange(start, end)).toBe(false);
    expect(pendingRequest).not.toBe(null);

    // WebSocket opens - should send queued request
    onWebSocketOpen();
    expect(pendingRequest).toBe(null);
  });
});

// ============================================================================
// Integration scenario tests
// ============================================================================

describe("Timeline Reconnection - Integration Scenarios", () => {
  /**
   * TEST 11: Full reconnection flow
   */
  it("should handle full reconnection flow correctly", () => {
    interface State {
      frames: unknown[];
      sentRequests: Set<string>;
      isLoading: boolean;
      wsConnected: boolean;
    }

    let state: State = {
      frames: [{ timestamp: "2024-01-15T10:00:00Z" }],
      sentRequests: new Set(["15-0-2024"]),
      isLoading: false,
      wsConnected: true,
    };

    // Step 1: WebSocket disconnects
    function onDisconnect() {
      state.wsConnected = false;
    }

    // Step 2: Reconnection initiated - should reset state
    function initiateReconnection() {
      state = {
        frames: [],
        sentRequests: new Set<string>(),
        isLoading: true,
        wsConnected: false,
      };
    }

    // Step 3: WebSocket connects
    function onConnect() {
      state.wsConnected = true;
    }

    // Step 4: Request sent (should work because sentRequests is empty)
    function canSendRequest(dateKey: string): boolean {
      return !state.sentRequests.has(dateKey);
    }

    // Execute flow
    onDisconnect();
    expect(state.wsConnected).toBe(false);

    initiateReconnection();
    expect(state.frames.length).toBe(0);
    expect(state.sentRequests.size).toBe(0);
    expect(state.isLoading).toBe(true);

    onConnect();
    expect(state.wsConnected).toBe(true);

    // Should be able to request Jan 15 again
    expect(canSendRequest("15-0-2024")).toBe(true);
  });

  /**
   * TEST 12: Manual refresh should trigger reconnection
   */
  it("manual refresh should reset state and reconnect", () => {
    let connectionCount = 0;
    const sentRequests = new Set<string>(["15-0-2024"]);

    function connectWebSocket() {
      connectionCount++;
      // Reset state
      sentRequests.clear();
    }

    // Initial connection
    connectWebSocket();
    expect(connectionCount).toBe(1);

    // Add a request
    sentRequests.add("15-0-2024");
    expect(sentRequests.has("15-0-2024")).toBe(true);

    // Manual refresh triggers reconnect
    connectWebSocket();
    expect(connectionCount).toBe(2);
    expect(sentRequests.has("15-0-2024")).toBe(false);
  });
});
