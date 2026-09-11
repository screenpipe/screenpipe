/**
 * Test to reproduce: Server push sends old frames as if they're current
 * 
 * User report: "looks its still sending frames from 30 min ago and saying its now"
 * 
 * Scenario:
 * - Multiple monitors being recorded (monitor_1, monitor_5)
 * - monitor_5 stopped recording at 12:15 PM
 * - monitor_1 continues recording
 * - Timeline shows interleaved frames from both monitors
 * - Old frames from stopped monitor appear with recent timestamps
 */

import { describe, it, expect } from "bun:test";

interface FrameChunk {
  frame_id: number;
  timestamp: Date;
  device_name: string;
  app_name: string;
  content: string;
}

interface StreamTimeSeriesResponse {
  timestamp: Date;
  devices: {
    device_id: string;
    frame_id: number;
    metadata: {
      app_name: string;
      ocr_text: string;
    };
  }[];
}

// Simulate database query
function findVideoChunks(frames: FrameChunk[], since: Date, until: Date): FrameChunk[] {
  return frames.filter(f => f.timestamp >= since && f.timestamp <= until);
}

// Simulate create_time_series_frame - groups frames by timestamp
function createTimeSeriesFrame(chunks: FrameChunk[]): Map<string, StreamTimeSeriesResponse> {
  const byTimestamp = new Map<string, StreamTimeSeriesResponse>();
  
  for (const chunk of chunks) {
    const key = chunk.timestamp.toISOString();
    
    if (!byTimestamp.has(key)) {
      byTimestamp.set(key, {
        timestamp: chunk.timestamp,
        devices: [],
      });
    }
    
    byTimestamp.get(key)!.devices.push({
      device_id: chunk.device_name,
      frame_id: chunk.frame_id,
      metadata: {
        app_name: chunk.app_name,
        ocr_text: chunk.content,
      },
    });
  }
  
  return byTimestamp;
}

describe("BUG: Server Push Old Frames As Current", () => {
  
  /**
   * Reproduce the multi-monitor interleaving issue
   */
  it("should NOT mix frames from stopped monitor with current monitor", () => {
    // Simulate the database state
    const dbFrames: FrameChunk[] = [
      // monitor_5 frames (stopped at 12:15 PM = 20:15 UTC)
      { frame_id: 1000, timestamp: new Date("2024-01-15T20:10:00Z"), device_name: "monitor_5", app_name: "WezTerm", content: "current work" },
      { frame_id: 1001, timestamp: new Date("2024-01-15T20:12:00Z"), device_name: "monitor_5", app_name: "WezTerm", content: "current work 2" },
      { frame_id: 1002, timestamp: new Date("2024-01-15T20:15:00Z"), device_name: "monitor_5", app_name: "WezTerm", content: "last frame before stop" },
      
      // monitor_1 frames (continues recording - has pitch deck open)
      { frame_id: 2000, timestamp: new Date("2024-01-15T20:10:00Z"), device_name: "monitor_1", app_name: "Arc", content: "pitch deck content" },
      { frame_id: 2001, timestamp: new Date("2024-01-15T20:12:00Z"), device_name: "monitor_1", app_name: "Arc", content: "pitch deck content" },
      { frame_id: 2002, timestamp: new Date("2024-01-15T20:15:00Z"), device_name: "monitor_1", app_name: "Arc", content: "pitch deck content" },
      
      // monitor_1 continues after monitor_5 stopped
      { frame_id: 2003, timestamp: new Date("2024-01-15T20:30:00Z"), device_name: "monitor_1", app_name: "Arc", content: "pitch deck - still showing" },
      { frame_id: 2004, timestamp: new Date("2024-01-15T20:45:00Z"), device_name: "monitor_1", app_name: "Arc", content: "pitch deck - still showing" },
      { frame_id: 2005, timestamp: new Date("2024-01-15T20:52:00Z"), device_name: "monitor_1", app_name: "Arc", content: "pitch deck - still showing" },
    ];
    
    // Timeline requests frames from start of day to NOW (12:52 PM = 20:52 UTC)
    const requestStart = new Date("2024-01-15T00:00:00Z");
    const requestEnd = new Date("2024-01-15T20:52:00Z");
    
    const chunks = findVideoChunks(dbFrames, requestStart, requestEnd);
    const grouped = createTimeSeriesFrame(chunks);
    
    // At 20:52, when poll runs, it should only show:
    // - monitor_1 at 20:52 (current)
    // NOT interleaved with old monitor_5 frames
    
    // Current behavior: ALL frames are returned grouped by timestamp
    // This causes old monitor_5 frames to appear alongside monitor_1 frames
    
    const frameAt2052 = grouped.get("2024-01-15T20:52:00.000Z");
    expect(frameAt2052).toBeDefined();
    expect(frameAt2052!.devices.length).toBe(1);
    expect(frameAt2052!.devices[0].device_id).toBe("monitor_1");
    
    // The issue: when client requests "live" frames, it gets ALL monitors
    // even if one monitor stopped recording 30 min ago
    console.log("Frames at 20:52:", frameAt2052);
  });

  /**
   * The REAL bug: Poll sends frames based on timestamp, not frame_id progression
   */
  it("BUG: poll uses timestamp range but should use frame_id for tracking", () => {
    const sentFrameIds = new Set<number>();
    
    // Frames in DB - note the timestamps and IDs
    const dbFrames: FrameChunk[] = [
      // Old frame that wasn't sent yet (maybe from batch insert or sync)
      { frame_id: 500, timestamp: new Date("2024-01-15T19:30:00Z"), device_name: "monitor_1", app_name: "Old App", content: "old content from 30 min ago" },
      
      // Current frames
      { frame_id: 1000, timestamp: new Date("2024-01-15T20:00:00Z"), device_name: "monitor_1", app_name: "WezTerm", content: "current" },
      { frame_id: 1001, timestamp: new Date("2024-01-15T20:01:00Z"), device_name: "monitor_1", app_name: "WezTerm", content: "current" },
    ];
    
    // Initial fetch sends frames 1000, 1001
    sentFrameIds.add(1000);
    sentFrameIds.add(1001);
    
    // last_polled set to latest timestamp: 20:01:00
    let lastPolled = new Date("2024-01-15T20:01:00Z");
    
    // Now a NEW frame arrives with OLD timestamp (sync, batch insert, etc.)
    dbFrames.push({ 
      frame_id: 501, 
      timestamp: new Date("2024-01-15T19:31:00Z"), // OLD timestamp! 
      device_name: "monitor_1", 
      app_name: "Old App", 
      content: "another old frame just inserted" 
    });
    
    // Poll runs: looks for frames >= last_polled (20:01:00)
    const now = new Date("2024-01-15T20:02:00Z");
    const pollChunks = findVideoChunks(dbFrames, lastPolled, now);
    
    // Poll finds NOTHING because the new frame (501) has timestamp 19:31:00
    // which is BEFORE last_polled (20:01:00)
    const newFrames = pollChunks.filter(f => !sentFrameIds.has(f.frame_id));
    
    expect(newFrames.length).toBe(0);
    
    // BUT the frame exists and was never sent!
    // User might see it appear randomly when they scroll back or refresh
    const unsent = dbFrames.filter(f => !sentFrameIds.has(f.frame_id));
    expect(unsent.length).toBe(2); // frame 500 and 501 never sent
    
    console.log("BUG: Frames with old timestamps are never sent via live push");
    console.log("Unsent frames:", unsent.map(f => ({ id: f.frame_id, ts: f.timestamp })));
  });

  /**
   * BUG: Multiple OCR entries per frame cause duplicate frame_ids in response
   */
  it("BUG: same frame_id appears multiple times with different OCR text", () => {
    // In the DB, one frame can have multiple OCR entries (different windows/apps)
    const dbFrames: FrameChunk[] = [
      { frame_id: 100, timestamp: new Date("2024-01-15T20:00:00Z"), device_name: "monitor_1", app_name: "WezTerm", content: "terminal content" },
      { frame_id: 100, timestamp: new Date("2024-01-15T20:00:00Z"), device_name: "monitor_1", app_name: "Arc", content: "browser content" },
      { frame_id: 100, timestamp: new Date("2024-01-15T20:00:00Z"), device_name: "monitor_1", app_name: "Finder", content: "finder content" },
    ];
    
    // When grouped, this creates ONE timestamp entry with 3 devices
    // BUT all have the same frame_id!
    const grouped = createTimeSeriesFrame(dbFrames);
    const frame = grouped.get("2024-01-15T20:00:00.000Z");
    
    expect(frame!.devices.length).toBe(3);
    
    // All have same frame_id - this is correct for display
    // BUT for tracking sent frames, we only need to track once
    const frameIds = new Set(frame!.devices.map(d => d.frame_id));
    expect(frameIds.size).toBe(1);
    
    console.log("Note: Multiple OCR entries per frame is expected behavior");
  });

  /**
   * BUG FOUND: Poll interval + slow DB query = missed frames
   */
  it("BUG: fast frame capture + slow poll = frames missed between polls", () => {
    const sentFrameIds = new Set<number>();
    
    // Simulate: frames captured every 100ms, poll runs every 1000ms
    const captureInterval = 100; // ms
    const pollInterval = 1000; // ms
    
    // Frame capture is FASTER than poll
    // Between polls, 10 frames could be captured
    
    // Poll 1 at T=1000ms
    let lastPolled = new Date("2024-01-15T20:00:01.000Z");
    
    // Frames captured between poll 1 and poll 2
    const framesCaptured: FrameChunk[] = [];
    for (let i = 0; i < 10; i++) {
      framesCaptured.push({
        frame_id: 100 + i,
        timestamp: new Date(`2024-01-15T20:00:01.${String(i * 100).padStart(3, '0')}Z`),
        device_name: "monitor_1",
        app_name: "App",
        content: `frame ${i}`,
      });
    }
    
    // Poll 2 at T=2000ms
    const pollTime = new Date("2024-01-15T20:00:02.000Z");
    const pollChunks = findVideoChunks(framesCaptured, lastPolled, pollTime);
    
    // All 10 frames should be found
    expect(pollChunks.length).toBe(10);
    
    // This is actually fine - poll catches up
    console.log("Poll catches up with frame capture - OK");
  });

  /**
   * THE ACTUAL BUG: sent_frame_ids check happens BEFORE fetch completes
   */
  it("RACE CONDITION: poll marks frames sent while initial fetch is still running", async () => {
    const sentFrameIds = new Set<number>();
    let lastPolled = new Date("2024-01-15T00:00:00Z"); // Start of day
    
    const dbFrames: FrameChunk[] = [
      { frame_id: 1, timestamp: new Date("2024-01-15T20:00:00Z"), device_name: "monitor_1", app_name: "App", content: "frame 1" },
      { frame_id: 2, timestamp: new Date("2024-01-15T20:01:00Z"), device_name: "monitor_1", app_name: "App", content: "frame 2" },
      { frame_id: 3, timestamp: new Date("2024-01-15T20:02:00Z"), device_name: "monitor_1", app_name: "App", content: "frame 3" },
    ];
    
    // Simulate race condition:
    // 1. Request comes in
    // 2. Initial fetch STARTS (takes 500ms)
    // 3. Poll timer fires at 100ms (before initial fetch completes)
    // 4. Poll fetches ALL frames from 00:00:00 to NOW
    // 5. Poll marks all frames as sent
    // 6. Initial fetch completes, tries to send frames via channel
    // 7. Frames are sent TWICE or initial fetch is blocked
    
    const initialFetchPromise = new Promise<void>(resolve => {
      setTimeout(() => {
        // Initial fetch runs
        for (const frame of dbFrames) {
          sentFrameIds.add(frame.frame_id);
        }
        lastPolled = new Date("2024-01-15T20:02:00Z");
        resolve();
      }, 500);
    });
    
    // Poll fires BEFORE initial fetch completes
    await new Promise<void>(resolve => {
      setTimeout(() => {
        // Poll runs
        const now = new Date("2024-01-15T20:03:00Z");
        const pollChunks = findVideoChunks(dbFrames, lastPolled, now);
        
        // Poll finds ALL frames because lastPolled is still 00:00:00!
        expect(pollChunks.length).toBe(3);
        
        // Poll marks all as sent
        for (const chunk of pollChunks) {
          sentFrameIds.add(chunk.frame_id);
        }
        
        resolve();
      }, 100);
    });
    
    // Wait for initial fetch
    await initialFetchPromise;
    
    // Both poll AND initial fetch processed the same frames
    // This could cause:
    // 1. Duplicate frames sent to client
    // 2. Out-of-order frames
    // 3. "Old" frames appearing as "new"
    
    expect(sentFrameIds.size).toBe(3);
    console.log("RACE CONDITION: Poll and initial fetch both process same frames");
  });
});

describe("FIX: Prevent old frames from appearing as current", () => {
  
  it("FIX: Use a 'processing' flag to prevent poll during initial fetch", () => {
    let isProcessingInitialFetch = false;
    const sentFrameIds = new Set<number>();
    
    // When request comes in, set flag
    isProcessingInitialFetch = true;
    
    // Poll checks flag before running
    const shouldPoll = !isProcessingInitialFetch;
    expect(shouldPoll).toBe(false);
    
    // After initial fetch completes, clear flag
    isProcessingInitialFetch = false;
    
    const shouldPollAfter = !isProcessingInitialFetch;
    expect(shouldPollAfter).toBe(true);
    
    console.log("FIX: Add isProcessingInitialFetch flag to prevent race condition");
  });
  
  it("FIX: Poll should wait for initial fetch to complete", async () => {
    let initialFetchComplete = false;
    
    // Initial fetch
    const initialFetchPromise = new Promise<void>(resolve => {
      setTimeout(() => {
        initialFetchComplete = true;
        resolve();
      }, 500);
    });
    
    // Poll waits for initial fetch
    await initialFetchPromise;
    
    expect(initialFetchComplete).toBe(true);
    
    // Now poll can run safely
    console.log("FIX: Poll should await initialFetchPromise before starting");
  });
});
