// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpi.pe

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import * as handlers from "../../../components/chat/standalone/hooks/pi-event-handlers";
import * as quota from "../quota-errors";

type Detector = (error: string) => boolean;

const terminalDetector =
  (handlers as Record<string, unknown>).isTerminalQuotaError ??
  (quota as Record<string, unknown>).isTerminalQuotaOrPlanError;

describe("terminal Pi retry outcome", () => {
  it("provides one pure terminal detector with balanced positive and negative behavior", () => {
    expect(typeof terminalDetector).toBe("function");
    const detect = terminalDetector as Detector;
    for (const error of [
      'HTTP 429 {"error":"daily_cost_limit_exceeded","required_plan":"business"}',
      "HTTP 429 credits_exhausted",
      '{"error":"model_not_allowed","required_plan":"business"}',
    ]) {
      expect(detect(error), error).toBe(true);
    }
    for (const error of [
      "HTTP 429 rate limit exceeded; wait 9 seconds",
      "500 upstream unavailable",
      "socket hang up",
    ]) {
      expect(detect(error), error).toBe(false);
    }
  });

  it("uses the terminal detector in the foreground event path that owns retries", () => {
    const source = readFileSync(
      join(
        process.cwd(),
        "components/chat/standalone/hooks/use-pi-foreground-events.ts",
      ),
      "utf8",
    );
    expect(source).toMatch(/\bisTerminalQuota(?:OrPlan)?Error\s*\(/);
    expect(source).toContain("classifyQuotaError");
    expect(source).toContain("PI_MAX_RATE_LIMIT_RETRIES");
  });
});
