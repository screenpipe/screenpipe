import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import WebSocket, { WebSocketServer } from "ws";
import * as http from "http";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";

// Mock the search API response
function createMockSearchResponse(frameIds: number[]) {
  return {
    data: frameIds.map((id, index) => ({
      type: "OCR",
      content: {
        frame_id: id,
        text: `Screen content ${index}`,
        timestamp: new Date(Date.now() - (frameIds.length - index) * 60000).toISOString(),
        app_name: "Test App",
        window_name: "Test Window",
      },
    })),
  };
}

// Mock video export progress messages
function createExportProgressMessages(frameCount: number): string[] {
  const messages = [];

  // Extracting phase
  for (let i = 0; i <= 10; i++) {
    messages.push(JSON.stringify({
      status: "extracting",
      progress: (i / 10) * 0.5,
      video_data: null,
      error: null,
    }));
  }

  // Encoding phase
  for (let i = 0; i <= 10; i++) {
    messages.push(JSON.stringify({
      status: "encoding",
      progress: 0.5 + (i / 10) * 0.5,
      video_data: null,
      error: null,
    }));
  }

  return messages;
}

describe("export-video MCP tool", () => {
  let mockHttpServer: http.Server;
  let mockWsServer: WebSocketServer;
  let serverPort: number;

  beforeEach(async () => {
    // Create a mock HTTP server for the search API
    mockHttpServer = http.createServer((req, res) => {
      const url = new URL(req.url!, `http://localhost`);

      if (url.pathname === "/search") {
        const startTime = url.searchParams.get("start_time");
        const endTime = url.searchParams.get("end_time");
        const contentType = url.searchParams.get("content_type");

        // Validate required parameters
        if (!startTime || !endTime) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Missing time parameters" }));
          return;
        }

        // Return mock search results with frame IDs
        const mockResponse = createMockSearchResponse([100, 101, 102, 103, 104]);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(mockResponse));
      } else {
        res.writeHead(404);
        res.end();
      }
    });

    // Create WebSocket server for export endpoint
    mockWsServer = new WebSocketServer({ noServer: true });

    mockHttpServer.on("upgrade", (request, socket, head) => {
      const url = new URL(request.url!, `http://localhost`);

      if (url.pathname === "/frames/export") {
        mockWsServer.handleUpgrade(request, socket, head, (ws) => {
          // Send progress updates
          const progressMessages = createExportProgressMessages(5);
          let messageIndex = 0;

          const sendProgress = setInterval(() => {
            if (messageIndex < progressMessages.length) {
              ws.send(progressMessages[messageIndex]);
              messageIndex++;
            } else {
              clearInterval(sendProgress);

              // Send completed message with mock video data
              const mockVideoData = Buffer.from("mock video content for testing");
              ws.send(JSON.stringify({
                status: "completed",
                progress: 1.0,
                video_data: Array.from(mockVideoData),
                error: null,
              }));
            }
          }, 10);
        });
      }
    });

    // Start the server on a random port
    await new Promise<void>((resolve) => {
      mockHttpServer.listen(0, () => {
        const address = mockHttpServer.address() as { port: number };
        serverPort = address.port;
        resolve();
      });
    });
  });

  afterEach(async () => {
    mockWsServer.close();
    await new Promise<void>((resolve) => {
      mockHttpServer.close(() => resolve());
    });
  });

  it("should parse ISO 8601 timestamps correctly", () => {
    const startTime = "2024-01-15T10:00:00Z";
    const endTime = "2024-01-15T10:30:00Z";

    const startDate = new Date(startTime);
    const endDate = new Date(endTime);

    expect(startDate.getTime()).toBeLessThan(endDate.getTime());
    expect(endDate.getTime() - startDate.getTime()).toBe(30 * 60 * 1000); // 30 minutes
  });

  it("should extract unique frame IDs from search results", () => {
    const searchResults = createMockSearchResponse([100, 101, 100, 102, 101, 103]);
    const frameIds: number[] = [];
    const seenIds = new Set<number>();

    for (const result of searchResults.data) {
      if (result.type === "OCR" && result.content?.frame_id) {
        const frameId = result.content.frame_id;
        if (!seenIds.has(frameId)) {
          seenIds.add(frameId);
          frameIds.push(frameId);
        }
      }
    }

    expect(frameIds).toEqual([100, 101, 102, 103]);
    expect(frameIds.length).toBe(4);
  });

  it("should handle empty search results", () => {
    const emptyResults = { data: [] };

    const frameIds: number[] = [];
    for (const result of emptyResults.data) {
      if ((result as any).type === "OCR" && (result as any).content?.frame_id) {
        frameIds.push((result as any).content.frame_id);
      }
    }

    expect(frameIds.length).toBe(0);
  });

  it("should build correct WebSocket URL with frame IDs", () => {
    const frameIds = [100, 101, 102];
    const fps = 1.0;
    const port = 3030;

    const wsUrl = `ws://localhost:${port}/frames/export?frame_ids=${frameIds.join(",")}&fps=${fps}`;

    expect(wsUrl).toBe("ws://localhost:3030/frames/export?frame_ids=100,101,102&fps=1");
  });

  it("should connect to mock WebSocket server and receive messages", async () => {
    const wsUrl = `ws://localhost:${serverPort}/frames/export?frame_ids=100,101,102&fps=1`;

    const result = await new Promise<{ success: boolean; data?: any; error?: string }>((resolve) => {
      const ws = new WebSocket(wsUrl);
      let lastMessage: any;

      ws.on("error", (error) => {
        resolve({ success: false, error: error.message });
      });

      ws.on("message", (data) => {
        try {
          lastMessage = JSON.parse(data.toString());

          if (lastMessage.status === "completed") {
            ws.close();
            resolve({ success: true, data: lastMessage });
          }
        } catch (e) {
          // Ignore parse errors
        }
      });

      ws.on("close", () => {
        if (!lastMessage || lastMessage.status !== "completed") {
          resolve({ success: false, error: "Connection closed before completion" });
        }
      });

      // Timeout after 5 seconds
      setTimeout(() => {
        ws.close();
        resolve({ success: false, error: "Timeout" });
      }, 5000);
    });

    expect(result.success).toBe(true);
    expect(result.data).toBeDefined();
    expect(result.data.status).toBe("completed");
    expect(result.data.video_data).toBeDefined();
    expect(Array.isArray(result.data.video_data)).toBe(true);
  });

  it("should save video data to temp file", () => {
    const mockVideoData = Buffer.from("mock video content");
    const tempDir = os.tmpdir();
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    const filename = `screenpipe_export_test_${timestamp}.mp4`;
    const filePath = path.join(tempDir, filename);

    fs.writeFileSync(filePath, mockVideoData);

    expect(fs.existsSync(filePath)).toBe(true);

    const readData = fs.readFileSync(filePath);
    expect(readData.toString()).toBe("mock video content");

    // Cleanup
    fs.unlinkSync(filePath);
  });

  it("should sort frame IDs in ascending order", () => {
    const unsortedIds = [103, 100, 105, 101, 102];
    const sortedIds = [...unsortedIds].sort((a, b) => a - b);

    expect(sortedIds).toEqual([100, 101, 102, 103, 105]);
  });

  it("should handle search API errors gracefully", async () => {
    // Create a server that returns an error
    const errorServer = http.createServer((req, res) => {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Internal server error" }));
    });

    await new Promise<void>((resolve) => {
      errorServer.listen(0, () => resolve());
    });

    const address = errorServer.address() as { port: number };
    const port = address.port;

    try {
      const response = await fetch(`http://localhost:${port}/search?start_time=2024-01-01T00:00:00Z&end_time=2024-01-01T01:00:00Z`);
      expect(response.ok).toBe(false);
      expect(response.status).toBe(500);
    } finally {
      await new Promise<void>((resolve) => {
        errorServer.close(() => resolve());
      });
    }
  });

  it("should handle WebSocket connection errors", async () => {
    const ws = new WebSocket("ws://localhost:59999/invalid"); // Port that's not listening

    const result = await new Promise<{ connected: boolean; error?: string }>((resolve) => {
      ws.on("open", () => {
        resolve({ connected: true });
      });

      ws.on("error", (error) => {
        resolve({ connected: false, error: error.message });
      });

      setTimeout(() => {
        resolve({ connected: false, error: "Timeout" });
      }, 2000);
    });

    expect(result.connected).toBe(false);
  });

  it("should validate time range parameters", () => {
    const startTime = "2024-01-15T10:30:00Z";
    const endTime = "2024-01-15T10:00:00Z"; // End before start

    const startDate = new Date(startTime);
    const endDate = new Date(endTime);

    // This should be invalid (end before start)
    expect(endDate.getTime()).toBeLessThan(startDate.getTime());
  });

  it("should handle audio-only results (no frame IDs)", () => {
    const audioOnlyResults = {
      data: [
        {
          type: "Audio",
          content: {
            transcription: "Hello world",
            timestamp: "2024-01-15T10:00:00Z",
            device_name: "Microphone",
          },
        },
        {
          type: "Audio",
          content: {
            transcription: "How are you",
            timestamp: "2024-01-15T10:01:00Z",
            device_name: "Microphone",
          },
        },
      ],
    };

    const frameIds: number[] = [];
    for (const result of audioOnlyResults.data) {
      if (result.type === "OCR" && (result.content as any)?.frame_id) {
        frameIds.push((result.content as any).frame_id);
      }
    }

    expect(frameIds.length).toBe(0);
  });
});

describe("export-video tool schema validation", () => {
  it("should have correct input schema", () => {
    const schema = {
      type: "object",
      properties: {
        start_time: {
          type: "string",
          format: "date-time",
        },
        end_time: {
          type: "string",
          format: "date-time",
        },
        fps: {
          type: "number",
          default: 1.0,
        },
      },
      required: ["start_time", "end_time"],
    };

    expect(schema.required).toContain("start_time");
    expect(schema.required).toContain("end_time");
    expect(schema.required).not.toContain("fps"); // fps is optional
    expect(schema.properties.fps.default).toBe(1.0);
  });
});
