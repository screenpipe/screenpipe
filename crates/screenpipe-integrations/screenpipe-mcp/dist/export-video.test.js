"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
const vitest_1 = require("vitest");
const ws_1 = __importStar(require("ws"));
const http = __importStar(require("http"));
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
const os = __importStar(require("os"));
// Mock the search API response
function createMockSearchResponse(frameIds) {
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
function createExportProgressMessages(frameCount) {
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
(0, vitest_1.describe)("export-video MCP tool", () => {
    let mockHttpServer;
    let mockWsServer;
    let serverPort;
    (0, vitest_1.beforeEach)(async () => {
        // Create a mock HTTP server for the search API
        mockHttpServer = http.createServer((req, res) => {
            const url = new URL(req.url, `http://localhost`);
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
            }
            else {
                res.writeHead(404);
                res.end();
            }
        });
        // Create WebSocket server for export endpoint
        mockWsServer = new ws_1.WebSocketServer({ noServer: true });
        mockHttpServer.on("upgrade", (request, socket, head) => {
            const url = new URL(request.url, `http://localhost`);
            if (url.pathname === "/frames/export") {
                mockWsServer.handleUpgrade(request, socket, head, (ws) => {
                    // Send progress updates
                    const progressMessages = createExportProgressMessages(5);
                    let messageIndex = 0;
                    const sendProgress = setInterval(() => {
                        if (messageIndex < progressMessages.length) {
                            ws.send(progressMessages[messageIndex]);
                            messageIndex++;
                        }
                        else {
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
        await new Promise((resolve) => {
            mockHttpServer.listen(0, () => {
                const address = mockHttpServer.address();
                serverPort = address.port;
                resolve();
            });
        });
    });
    (0, vitest_1.afterEach)(async () => {
        mockWsServer.close();
        await new Promise((resolve) => {
            mockHttpServer.close(() => resolve());
        });
    });
    (0, vitest_1.it)("should parse ISO 8601 timestamps correctly", () => {
        const startTime = "2024-01-15T10:00:00Z";
        const endTime = "2024-01-15T10:30:00Z";
        const startDate = new Date(startTime);
        const endDate = new Date(endTime);
        (0, vitest_1.expect)(startDate.getTime()).toBeLessThan(endDate.getTime());
        (0, vitest_1.expect)(endDate.getTime() - startDate.getTime()).toBe(30 * 60 * 1000); // 30 minutes
    });
    (0, vitest_1.it)("should extract unique frame IDs from search results", () => {
        const searchResults = createMockSearchResponse([100, 101, 100, 102, 101, 103]);
        const frameIds = [];
        const seenIds = new Set();
        for (const result of searchResults.data) {
            if (result.type === "OCR" && result.content?.frame_id) {
                const frameId = result.content.frame_id;
                if (!seenIds.has(frameId)) {
                    seenIds.add(frameId);
                    frameIds.push(frameId);
                }
            }
        }
        (0, vitest_1.expect)(frameIds).toEqual([100, 101, 102, 103]);
        (0, vitest_1.expect)(frameIds.length).toBe(4);
    });
    (0, vitest_1.it)("should handle empty search results", () => {
        const emptyResults = { data: [] };
        const frameIds = [];
        for (const result of emptyResults.data) {
            if (result.type === "OCR" && result.content?.frame_id) {
                frameIds.push(result.content.frame_id);
            }
        }
        (0, vitest_1.expect)(frameIds.length).toBe(0);
    });
    (0, vitest_1.it)("should build correct WebSocket URL with frame IDs", () => {
        const frameIds = [100, 101, 102];
        const fps = 1.0;
        const port = 3030;
        const wsUrl = `ws://localhost:${port}/frames/export?frame_ids=${frameIds.join(",")}&fps=${fps}`;
        (0, vitest_1.expect)(wsUrl).toBe("ws://localhost:3030/frames/export?frame_ids=100,101,102&fps=1");
    });
    (0, vitest_1.it)("should connect to mock WebSocket server and receive messages", async () => {
        const wsUrl = `ws://localhost:${serverPort}/frames/export?frame_ids=100,101,102&fps=1`;
        const result = await new Promise((resolve) => {
            const ws = new ws_1.default(wsUrl);
            let lastMessage;
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
                }
                catch (e) {
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
        (0, vitest_1.expect)(result.success).toBe(true);
        (0, vitest_1.expect)(result.data).toBeDefined();
        (0, vitest_1.expect)(result.data.status).toBe("completed");
        (0, vitest_1.expect)(result.data.video_data).toBeDefined();
        (0, vitest_1.expect)(Array.isArray(result.data.video_data)).toBe(true);
    });
    (0, vitest_1.it)("should save video data to temp file", () => {
        const mockVideoData = Buffer.from("mock video content");
        const tempDir = os.tmpdir();
        const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
        const filename = `screenpipe_export_test_${timestamp}.mp4`;
        const filePath = path.join(tempDir, filename);
        fs.writeFileSync(filePath, mockVideoData);
        (0, vitest_1.expect)(fs.existsSync(filePath)).toBe(true);
        const readData = fs.readFileSync(filePath);
        (0, vitest_1.expect)(readData.toString()).toBe("mock video content");
        // Cleanup
        fs.unlinkSync(filePath);
    });
    (0, vitest_1.it)("should sort frame IDs in ascending order", () => {
        const unsortedIds = [103, 100, 105, 101, 102];
        const sortedIds = [...unsortedIds].sort((a, b) => a - b);
        (0, vitest_1.expect)(sortedIds).toEqual([100, 101, 102, 103, 105]);
    });
    (0, vitest_1.it)("should handle search API errors gracefully", async () => {
        // Create a server that returns an error
        const errorServer = http.createServer((req, res) => {
            res.writeHead(500, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "Internal server error" }));
        });
        await new Promise((resolve) => {
            errorServer.listen(0, () => resolve());
        });
        const address = errorServer.address();
        const port = address.port;
        try {
            const response = await fetch(`http://localhost:${port}/search?start_time=2024-01-01T00:00:00Z&end_time=2024-01-01T01:00:00Z`);
            (0, vitest_1.expect)(response.ok).toBe(false);
            (0, vitest_1.expect)(response.status).toBe(500);
        }
        finally {
            await new Promise((resolve) => {
                errorServer.close(() => resolve());
            });
        }
    });
    (0, vitest_1.it)("should handle WebSocket connection errors", async () => {
        const ws = new ws_1.default("ws://localhost:59999/invalid"); // Port that's not listening
        const result = await new Promise((resolve) => {
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
        (0, vitest_1.expect)(result.connected).toBe(false);
    });
    (0, vitest_1.it)("should validate time range parameters", () => {
        const startTime = "2024-01-15T10:30:00Z";
        const endTime = "2024-01-15T10:00:00Z"; // End before start
        const startDate = new Date(startTime);
        const endDate = new Date(endTime);
        // This should be invalid (end before start)
        (0, vitest_1.expect)(endDate.getTime()).toBeLessThan(startDate.getTime());
    });
    (0, vitest_1.it)("should handle audio-only results (no frame IDs)", () => {
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
        const frameIds = [];
        for (const result of audioOnlyResults.data) {
            if (result.type === "OCR" && result.content?.frame_id) {
                frameIds.push(result.content.frame_id);
            }
        }
        (0, vitest_1.expect)(frameIds.length).toBe(0);
    });
});
(0, vitest_1.describe)("export-video tool schema validation", () => {
    (0, vitest_1.it)("should have correct input schema", () => {
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
        (0, vitest_1.expect)(schema.required).toContain("start_time");
        (0, vitest_1.expect)(schema.required).toContain("end_time");
        (0, vitest_1.expect)(schema.required).not.toContain("fps"); // fps is optional
        (0, vitest_1.expect)(schema.properties.fps.default).toBe(1.0);
    });
});
