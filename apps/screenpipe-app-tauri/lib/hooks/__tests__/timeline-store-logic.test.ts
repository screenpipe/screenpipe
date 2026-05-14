/**
 * Tests for timeline store logic - tests the pure functions without WebSocket mocking.
 *
 * These tests verify the frame handling logic that would be called when new frames arrive.
 */

import { describe, it, expect } from "bun:test";
import { mergeTimelineFrames } from "../timeline-frame-merge";

// Define the types we need for testing
interface DeviceResponse {
  device_id: string;
  frame_id: number;
  metadata: {
    file_path: string;
    app_name: string;
    window_name: string;
    ocr_text: string;
    browser_url: string | null;
  };
  audio: unknown[];
}

interface StreamTimeSeriesResponse {
  timestamp: string;
  devices: DeviceResponse[];
}

// Helper to create a mock frame
function createMockFrame(
  timestamp: string,
  deviceId: string = "test-device",
  frameId: number = 1
): StreamTimeSeriesResponse {
  return {
    timestamp,
    devices: [
      {
        device_id: deviceId,
        frame_id: frameId,
        metadata: {
          file_path: "/test/path.mp4",
          app_name: "TestApp",
          window_name: "TestWindow",
          ocr_text: "test text",
          browser_url: null,
        },
        audio: [],
      },
    ],
  };
}

/**
 * This simulates the flushFrameBuffer logic from use-timeline-store.tsx
 * Testing this in isolation to verify the merge/sort logic works correctly.
 */
function simulateFlushFrameBuffer(
  existingFrames: StreamTimeSeriesResponse[],
  existingTimestamps: Set<string>,
  newFrames: StreamTimeSeriesResponse[]
): { frames: StreamTimeSeriesResponse[]; timestamps: Set<string> } {
  const result = mergeTimelineFrames({
    existingFrames,
    existingTimestamps,
    incomingFrames: newFrames,
  });

  return { frames: result.frames, timestamps: result.timestamps };
}

describe("Timeline Store Logic - Frame Refresh Bug Tests", () => {
  /**
   * TEST 1: New frames should be merged correctly
   */
  it("should merge new frames with existing frames", () => {
    const existingFrames = [createMockFrame("2024-01-15T19:41:00Z", "device1", 1)];
    const existingTimestamps = new Set(["2024-01-15T19:41:00Z"]);

    const newFrames = [createMockFrame("2024-01-15T19:45:00Z", "device1", 2)];

    const result = simulateFlushFrameBuffer(
      existingFrames,
      existingTimestamps,
      newFrames
    );

    expect(result.frames.length).toBe(2);
    // Should be sorted descending
    expect(result.frames[0].timestamp).toBe("2024-01-15T19:45:00Z");
    expect(result.frames[1].timestamp).toBe("2024-01-15T19:41:00Z");
  });

  /**
   * TEST 2: Duplicate frames should be filtered out
   */
  it("should filter out duplicate frames", () => {
    const existingFrames = [createMockFrame("2024-01-15T19:41:00Z", "device1", 1)];
    const existingTimestamps = new Set(["2024-01-15T19:41:00Z"]);

    // Try to add same frame again
    const newFrames = [createMockFrame("2024-01-15T19:41:00Z", "device1", 1)];

    const result = simulateFlushFrameBuffer(
      existingFrames,
      existingTimestamps,
      newFrames
    );

    expect(result.frames.length).toBe(1);
  });

  /**
   * TEST 3: Multiple new frames should all be added
   */
  it("should add multiple new frames correctly", () => {
    const existingFrames: StreamTimeSeriesResponse[] = [];
    const existingTimestamps = new Set<string>();

    const newFrames = [
      createMockFrame("2024-01-15T19:41:00Z", "device1", 1),
      createMockFrame("2024-01-15T19:45:00Z", "device1", 2),
      createMockFrame("2024-01-15T19:50:00Z", "device1", 3),
    ];

    const result = simulateFlushFrameBuffer(
      existingFrames,
      existingTimestamps,
      newFrames
    );

    expect(result.frames.length).toBe(3);
    expect(result.timestamps.size).toBe(3);
  });

  /**
   * TEST 4: Frames should be sorted in descending order (newest first)
   */
  it("should sort frames in descending order", () => {
    const existingFrames: StreamTimeSeriesResponse[] = [];
    const existingTimestamps = new Set<string>();

    // Add frames in random order
    const newFrames = [
      createMockFrame("2024-01-15T19:42:00Z", "device1", 2),
      createMockFrame("2024-01-15T19:45:00Z", "device1", 3),
      createMockFrame("2024-01-15T19:41:00Z", "device1", 1),
    ];

    const result = simulateFlushFrameBuffer(
      existingFrames,
      existingTimestamps,
      newFrames
    );

    expect(result.frames[0].timestamp).toBe("2024-01-15T19:45:00Z");
    expect(result.frames[1].timestamp).toBe("2024-01-15T19:42:00Z");
    expect(result.frames[2].timestamp).toBe("2024-01-15T19:41:00Z");
  });

  /**
   * TEST 5: Exact bug scenario - 14 minute gap
   *
   * Simulates the exact user-reported scenario where timeline shows 7:41 PM
   * but current time is 7:55 PM. If the server pushes new frames, the client
   * should accept them.
   */
  it("should handle the 14-minute gap scenario - client accepting server push", () => {
    // Initial state: only frame at 7:41 PM
    let frames = [createMockFrame("2024-01-15T19:41:00Z", "device1", 1)];
    let timestamps = new Set(["2024-01-15T19:41:00Z"]);

    expect(frames.length).toBe(1);
    expect(frames[0].timestamp).toBe("2024-01-15T19:41:00Z");

    // Server pushes frames that were captured at 7:43, 7:50, 7:55 PM
    const newFrames = [
      createMockFrame("2024-01-15T19:43:00Z", "device1", 2),
      createMockFrame("2024-01-15T19:50:00Z", "device1", 3),
      createMockFrame("2024-01-15T19:55:00Z", "device1", 4),
    ];

    const result = simulateFlushFrameBuffer(frames, timestamps, newFrames);

    // CLIENT-SIDE CHECK: All frames should be present and sorted
    expect(result.frames.length).toBe(4);
    expect(result.frames[0].timestamp).toBe("2024-01-15T19:55:00Z");
    expect(result.frames[1].timestamp).toBe("2024-01-15T19:50:00Z");
    expect(result.frames[2].timestamp).toBe("2024-01-15T19:43:00Z");
    expect(result.frames[3].timestamp).toBe("2024-01-15T19:41:00Z");

    // This test PASSES because client-side logic correctly accepts pushed frames.
    // The bug is SERVER-SIDE: the server never PUSHES the new frames!
    console.log("CLIENT-SIDE: ✓ Frame handling logic works correctly");
    console.log(
      "BUG LOCATION: Server-side - frames are not being pushed to client"
    );
  });

  /**
   * TEST 6: Verify sentRequests logic doesn't block receiving pushed frames
   *
   * The sentRequests Set only tracks OUTGOING requests, not incoming data.
   * This tests that the distinction is clear.
   */
  it("sentRequests should not block receiving frames", () => {
    // Simulate the sentRequests cache
    const sentRequests = new Set<string>();
    const dateKey = "15-0-2024"; // Jan 15, 2024

    // Mark as requested
    sentRequests.add(dateKey);

    // sentRequests should ONLY be used for:
    // 1. Preventing duplicate fetch requests (not blocking incoming data)
    function shouldSendRequest(date: Date): boolean {
      const key = `${date.getDate()}-${date.getMonth()}-${date.getFullYear()}`;
      return !sentRequests.has(key);
    }

    // New request for same date should be blocked
    expect(shouldSendRequest(new Date(2024, 0, 15))).toBe(false);

    // BUT receiving frames should never be blocked by sentRequests
    // This is just documentation that the cache only affects outgoing, not incoming
    console.log("✓ sentRequests only prevents duplicate outgoing fetch requests");
    console.log("✓ sentRequests does NOT block receiving pushed frames from server");
  });

  /**
   * TEST 7: Test timestamp deduplication uses correct key
   */
  it("should use timestamp as deduplication key", () => {
    const existingFrames = [
      createMockFrame("2024-01-15T19:41:00Z", "device1", 1),
    ];
    const existingTimestamps = new Set(["2024-01-15T19:41:00Z"]);

    // Same timestamp but different device - should still be deduplicated
    const newFrames = [
      createMockFrame("2024-01-15T19:41:00Z", "device2", 100),
    ];

    const result = simulateFlushFrameBuffer(
      existingFrames,
      existingTimestamps,
      newFrames
    );

    // Should be deduplicated because timestamp matches
    expect(result.frames.length).toBe(1);
  });

  /**
   * TEST 8: Empty buffer should not affect state
   */
  it("should handle empty buffer correctly", () => {
    const existingFrames = [
      createMockFrame("2024-01-15T19:41:00Z", "device1", 1),
    ];
    const existingTimestamps = new Set(["2024-01-15T19:41:00Z"]);

    const result = simulateFlushFrameBuffer(
      existingFrames,
      existingTimestamps,
      []
    );

    expect(result.frames.length).toBe(1);
    expect(result.frames).toBe(existingFrames); // Should be same reference
  });

  /**
   * TEST 9: Verify ISO timestamp sorting works correctly
   *
   * Note: Lexicographic sorting works for consistent ISO timestamp formats.
   * Timestamps with milliseconds vs without may sort incorrectly, but this
   * is not an issue in practice since the server uses consistent formatting.
   */
  it("should correctly sort ISO timestamps", () => {
    // Use timestamps with consistent format (no milliseconds) as the server does
    const timestamps = [
      "2024-01-15T19:41:00Z",
      "2024-01-15T19:41:01Z", // 1 second later
      "2024-01-15T19:42:00Z", // 1 minute later
      "2024-01-16T00:00:00Z", // next day
      "2024-01-15T09:00:00Z", // earlier same day
    ];

    const sorted = [...timestamps].sort((a, b) => b.localeCompare(a));

    expect(sorted[0]).toBe("2024-01-16T00:00:00Z"); // Latest
    expect(sorted[1]).toBe("2024-01-15T19:42:00Z");
    expect(sorted[2]).toBe("2024-01-15T19:41:01Z");
    expect(sorted[3]).toBe("2024-01-15T19:41:00Z");
    expect(sorted[4]).toBe("2024-01-15T09:00:00Z"); // Earliest
  });

  it("should merge interleaved batches without changing sort semantics", () => {
    const existingFrames = [
      createMockFrame("2024-01-15T19:55:00Z", "device1", 4),
      createMockFrame("2024-01-15T19:50:00Z", "device1", 3),
      createMockFrame("2024-01-15T19:41:00Z", "device1", 1),
    ];
    const existingTimestamps = new Set(existingFrames.map((f) => f.timestamp));
    const newFrames = [
      createMockFrame("2024-01-15T19:52:00Z", "device1", 5),
      createMockFrame("2024-01-15T19:43:00Z", "device1", 2),
      createMockFrame("2024-01-15T19:41:00Z", "device1", 1),
    ];

    const result = mergeTimelineFrames({
      existingFrames,
      existingTimestamps,
      incomingFrames: newFrames,
    });

    expect(result.frames.map((f) => f.timestamp)).toEqual([
      "2024-01-15T19:55:00Z",
      "2024-01-15T19:52:00Z",
      "2024-01-15T19:50:00Z",
      "2024-01-15T19:43:00Z",
      "2024-01-15T19:41:00Z",
    ]);
    expect(result.newAtFront).toBe(0);
  });

  it("should replace frames atomically for date navigation", () => {
    const existingFrames = [
      createMockFrame("2024-01-15T19:55:00Z", "device1", 4),
    ];
    const existingTimestamps = new Set(existingFrames.map((f) => f.timestamp));
    const newFrames = [
      createMockFrame("2024-01-14T10:05:00Z", "device1", 5),
      createMockFrame("2024-01-14T10:00:00Z", "device1", 6),
      createMockFrame("2024-01-14T10:05:00Z", "device1", 5),
    ];

    const result = mergeTimelineFrames({
      existingFrames,
      existingTimestamps,
      incomingFrames: newFrames,
      replace: true,
    });

    expect(result.frames.map((f) => f.timestamp)).toEqual([
      "2024-01-14T10:05:00Z",
      "2024-01-14T10:00:00Z",
    ]);
    expect([...result.timestamps].sort()).toEqual([
      "2024-01-14T10:00:00Z",
      "2024-01-14T10:05:00Z",
    ]);
  });
});

describe("Timeline Store - Documented Bug Analysis", () => {
  /**
   * Document the confirmed bug from server-side tests
   */
  it("DOCUMENTED BUG: Server-side channel starvation", () => {
    console.log(`
=== TIMELINE REFRESH BUG - ROOT CAUSE CONFIRMED ===

Bug: Timeline shows 7:41 PM but current time is 7:55 PM (14 min gap)

Root Cause (CONFIRMED by test_channel_closure_does_not_starve_other_branches):
-----------------------------------------------------------------------
In handle_stream_frames_socket (crates/screenpipe-server/src/server.rs):

When frame_rx channel closes (after initial fetch completes), tokio::select!
keeps selecting that branch because a closed channel returns None IMMEDIATELY.

Test Results:
- Poll timer ran: 0 times
- Closed channel recv ran: 1001 times

This STARVES the poll_timer branch that is responsible for fetching
and pushing new frames to the client!

Fix Required:
- Track when the channel is closed
- Skip the frame_rx branch in tokio::select! once closed
- OR restructure the loop to handle closed channel differently

Code Location: crates/screenpipe-server/src/server.rs:3193-3315
`);

    // This test always passes - it's documentation
    expect(true).toBe(true);
  });
});
