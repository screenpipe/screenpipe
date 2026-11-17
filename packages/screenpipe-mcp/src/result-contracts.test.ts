// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com
import { expect, it } from "vitest";
import {
  normalizeNonNegativeInt,
  normalizePositiveInt,
  zeroHitCoverageText,
} from "./result-contracts";

it("states coverage and distinguishes zero matches from an error", () => {
  const text = zeroHitCoverageText("keyword-search", {
    query: "zephyrium",
    start_time: "2026-11-01T00:00:00Z",
    end_time: "2026-11-16T00:00:00Z",
    app: "cmux",
    limit: 10,
    offset: 0,
    details: "fuzzy_match=false",
  });
  expect(text).toContain("No results for keyword-search");
  expect(text).toContain("zero results; this is not an error");
  expect(text).toContain("Coverage:");
  expect(text).toContain("query=zephyrium");
  expect(text).toContain("start_time=2026-11-01T00:00:00Z");
  expect(text).toContain("end_time=2026-11-16T00:00:00Z");
  expect(text).toContain("app=cmux");
  expect(text).toContain("limit=10");
  expect(text).toContain("offset=0");
  expect(text).toContain("fuzzy_match=false");
  expect(text).toContain("wider start_time/end_time");
});

it("discloses unbounded defaults instead of hiding them", () => {
  const text = zeroHitCoverageText("search-content");
  expect(text).toContain("start_time=(unbounded)");
  expect(text).toContain("end_time=(unbounded)");
  expect(text).toContain("app=(all)");
  expect(text).toContain("limit=(default)");
  expect(text).toContain("offset=0");
});

it("coerces integer arguments serialized as floats or numeric strings", () => {
  expect(normalizePositiveInt("268.0")).toBe(268);
  expect(normalizePositiveInt("268")).toBe(268);
  expect(normalizePositiveInt(" 268 ")).toBe(268);
  expect(normalizePositiveInt(268)).toBe(268);
  expect(normalizePositiveInt(268.0)).toBe(268);
  expect(normalizeNonNegativeInt("400.0")).toBe(400);
  expect(normalizeNonNegativeInt(0)).toBe(0);
  expect(normalizeNonNegativeInt("0")).toBe(0);
  expect(normalizeNonNegativeInt(undefined)).toBeNull();
});

it("rejects fractional, negative and non-numeric arguments", () => {
  expect(normalizePositiveInt("268.5")).toBeNull();
  expect(normalizePositiveInt("-1")).toBeNull();
  expect(normalizePositiveInt(0)).toBeNull();
  expect(normalizePositiveInt(-3)).toBeNull();
  expect(normalizePositiveInt("meeting-268")).toBeNull();
  expect(normalizePositiveInt(null)).toBeNull();
  expect(normalizePositiveInt(1.5)).toBeNull();
  expect(normalizeNonNegativeInt("-1")).toBeNull();
});
