// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpi.pe

import { describe, it, expect } from "vitest";
import {
  formatSection,
  formatOptionalSection,
  formatPagination,
  formatQuery,
  formatDeepLink,
  flattenObject,
  formatToolError,
} from "./helpers";

describe("formatSection", () => {
  it("returns empty string for empty lines", () => {
    expect(formatSection("Title", [])).toBe("");
  });

  it("renders ### header with lines", () => {
    expect(formatSection("Status", ["ok", "running"])).toBe("### Status\nok\nrunning");
  });
});

describe("formatOptionalSection", () => {
  it("renders section when condition is true", () => {
    expect(formatOptionalSection("Warnings", ["w1"], true)).toBe("### Warnings\nw1");
  });

  it("returns empty string when condition is false", () => {
    expect(formatOptionalSection("Warnings", ["w1"], false)).toBe("");
  });
});

describe("formatPagination", () => {
  it("returns empty string when all results fit", () => {
    expect(formatPagination(10, 10, 0, "search-content")).toBe("");
  });

  it("shows correct next offset on first page", () => {
    const hint = formatPagination(20, 100, 0, "search-content");
    expect(hint).toContain("offset=20");
    expect(hint).toContain("1–20 of 100");
  });

  it("shows correct next offset on a later page (offset=80)", () => {
    const hint = formatPagination(20, 100, 80, "search-content");
    // offset+count = 100 which equals total, so no more pages
    expect(hint).toBe("");
  });

  it("shows correct next offset mid-page (offset=60, count=20, total=100)", () => {
    const hint = formatPagination(20, 100, 60, "search-content");
    expect(hint).toContain("offset=80");
    expect(hint).toContain("61–80 of 100");
  });

  it("shows soft hint when total is unknown", () => {
    const hint = formatPagination(15, null, 0, "search-content");
    expect(hint).toContain("15 results shown");
    expect(hint).toContain("offset");
  });

  it("returns empty when count is 0 and total is unknown", () => {
    expect(formatPagination(0, null, 0, "search-content")).toBe("");
  });
});

describe("formatQuery", () => {
  it("skips null and undefined values", () => {
    const result = formatQuery({ q: "hello", limit: undefined, offset: null });
    expect(result).toContain("- q: hello");
    expect(result).not.toContain("limit");
    expect(result).not.toContain("offset");
  });

  it("skips empty string values", () => {
    const result = formatQuery({ q: "", app_name: "Chrome" });
    expect(result).not.toContain("q:");
    expect(result).toContain("app_name: Chrome");
  });

  it("skips non-primitive values safely (no cast needed)", () => {
    const result = formatQuery({ q: "test", nested: { foo: "bar" }, arr: [1, 2] });
    expect(result).toContain("- q: test");
    expect(result).not.toContain("nested");
    expect(result).not.toContain("arr");
  });

  it("returns empty string when no valid params", () => {
    expect(formatQuery({ a: null, b: undefined })).toBe("");
  });

  it("includes boolean and number params", () => {
    const result = formatQuery({ include_frames: true, limit: 50 });
    expect(result).toContain("- include_frames: true");
    expect(result).toContain("- limit: 50");
  });
});

describe("formatDeepLink", () => {
  it("returns frame link when frameId is provided", () => {
    expect(formatDeepLink(42)).toBe("  → [frame 42](screenpipe://frame/42)");
  });

  it("handles frameId === 0 correctly (not falsy)", () => {
    expect(formatDeepLink(0)).toBe("  → [frame 0](screenpipe://frame/0)");
  });

  it("falls back to timeline link when frameId is null", () => {
    const link = formatDeepLink(null, "2024-01-15T10:00:00Z");
    expect(link).toContain("screenpipe://timeline");
    expect(link).toContain("2024-01-15T10%3A00%3A00Z");
  });

  it("returns empty string when both are absent", () => {
    expect(formatDeepLink(null)).toBe("");
    expect(formatDeepLink(undefined)).toBe("");
  });
});

describe("flattenObject", () => {
  it("flattens scalar values to key: value lines", () => {
    const lines = flattenObject({ workers: 4, queue: "ready" });
    expect(lines).toContain("  workers: 4");
    expect(lines).toContain("  queue: ready");
  });

  it("JSON-stringifies nested objects inline", () => {
    const lines = flattenObject({ stats: { hits: 10 } });
    expect(lines[0]).toBe('  stats: {"hits":10}');
  });
});

describe("formatToolError", () => {
  it("categorizes ECONNREFUSED as connection error", () => {
    const result = formatToolError("health-check", new Error("ECONNREFUSED 127.0.0.1:3030"), "http://localhost:3030");
    expect(result).toContain("### Error");
    expect(result).toContain("Could not reach screenpipe");
    expect(result).toContain("http://localhost:3030");
  });

  it("categorizes HTTP 401 with correct detail", () => {
    const result = formatToolError("search-content", new Error("HTTP error: 401"));
    expect(result).toContain("Invalid or missing API key.");
  });

  it("categorizes HTTP 404 with correct detail", () => {
    const result = formatToolError("get-meeting", new Error("HTTP error: 404"));
    expect(result).toContain("Resource not found.");
  });

  it("categorizes HTTP 503 with correct detail", () => {
    const result = formatToolError("health-check", new Error("HTTP 503"));
    expect(result).toContain("screenpipe service is unavailable.");
  });

  it("matches 'HTTP 404' form (export-video style)", () => {
    const result = formatToolError("export-video", new Error("Failed to search for frames: HTTP 500"));
    expect(result).toContain("Server returned 500.");
  });

  it("returns generic ### Error for unknown errors", () => {
    const result = formatToolError("search-content", new Error("something unexpected"));
    expect(result).toBe("### Error\nsomething unexpected");
  });

  it("handles non-Error thrown values", () => {
    const result = formatToolError("health-check", "string thrown");
    expect(result).toContain("### Error");
    expect(result).toContain("string thrown");
  });
});
