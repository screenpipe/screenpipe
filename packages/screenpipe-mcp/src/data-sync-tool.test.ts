// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com

import { describe, expect, it } from "vitest";
import {
  handleSearchSyncedContent,
  handleSyncedDevices,
} from "./data-sync-tool";

function httpError(status: number, bodyText: string) {
  return Object.assign(new Error(`HTTP ${status}: ${bodyText}`), {
    name: "BackendHttpError",
    status,
    bodyText,
  });
}

function jsonResponse(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    headers: { "content-type": "application/json" },
  });
}

describe("data-sync MCP handlers", () => {
  it("returns clean guidance when synced-devices reports data_sync_disabled (403)", async () => {
    const result = await handleSyncedDevices(async () => {
      throw httpError(403, JSON.stringify({ error: "data_sync_disabled" }));
    });

    expect(result.isError).toBeUndefined();
    expect(result.content[0].text).toContain("Data Sync is off");
    expect(result.content[0].text).toContain("search-content");
  });

  it("returns clean guidance when synced-devices reports cloud_token_missing (503)", async () => {
    const result = await handleSyncedDevices(async () => {
      throw httpError(
        503,
        JSON.stringify({
          error: "cloud_token_missing",
          message: "sign in to screenpipe to query synced devices",
        }),
      );
    });

    expect(result.isError).toBeUndefined();
    expect(result.content[0].text).toContain("not signed in");
    expect(result.content[0].text).toContain("search-content");
  });

  it("returns clean guidance when search-synced-content reports data_sync_disabled (403)", async () => {
    const result = await handleSearchSyncedContent(
      { q: "pricing", since_hours_ago: 24 },
      async () => {
        throw httpError(403, JSON.stringify({ error: "data_sync_disabled" }));
      },
    );

    expect(result.isError).toBeUndefined();
    expect(result.content[0].text).toContain("Data Sync is off");
    expect(result.content[0].text).toContain("search-content");
  });

  it("still throws genuine auth (401) and server (502) failures", async () => {
    await expect(
      handleSyncedDevices(async () => {
        throw httpError(401, JSON.stringify({ error: "token_expired" }));
      }),
    ).rejects.toThrow("HTTP 401");

    await expect(
      handleSearchSyncedContent({ q: "test" }, async () => {
        throw httpError(502, JSON.stringify({ error: "upstream_unreachable" }));
      }),
    ).rejects.toThrow("HTTP 502");
  });

  it("formats synced devices and synced search hits on success", async () => {
    const devicesRes = await handleSyncedDevices(async () =>
      jsonResponse({
        devices: [
          {
            device_name: "MacBook Pro",
            device_id: "dev-1",
            last_synced_at: "2026-11-24T12:00:00Z",
            platform: "macos",
          },
        ],
      }),
    );
    expect(devicesRes.content[0].text).toBe(
      "MacBook Pro (dev-1) — last synced 2026-11-24T12:00:00Z — macos",
    );

    const searchRes = await handleSearchSyncedContent(
      { q: "budget", limit: 10 },
      async (endpoint) => {
        expect(endpoint).toBe("/data-sync/search?q=budget&limit=10");
        return jsonResponse({
          truncated: true,
          results: [
            {
              device: "MacBook Pro",
              t: "2026-11-24T11:30:00Z",
              app: "Slack",
              text: "Approved the Q4 budget",
            },
          ],
        });
      },
    );
    expect(searchRes.content[0].text).toContain("Results are truncated");
    expect(searchRes.content[0].text).toContain(
      "[MacBook Pro] 2026-11-24T11:30:00Z — Slack\nApproved the Q4 budget",
    );
  });
});
