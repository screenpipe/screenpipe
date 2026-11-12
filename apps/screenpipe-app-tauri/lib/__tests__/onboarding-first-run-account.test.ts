// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com

import { afterEach, expect, it, vi } from "vitest";
import { firstRunAccountFixture } from "../../e2e/helpers/onboarding-first-run-account";
import { getLocalPlanPolicy, hasAppEntitlement, normalizeAppUser } from "../app-entitlement";

afterEach(() => vi.useRealTimers());

it.each(["none", "lifetime"] as const)("keeps the %s onboarding premise after real account normalization", (plan) => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-11-12T12:00:00.000Z"));
  const fixture = firstRunAccountFixture(plan);
  expect(getLocalPlanPolicy(fixture)).toBe(plan === "lifetime" ? "verified-paid" : "verified-free");
  const user = normalizeAppUser(JSON.parse(JSON.stringify(fixture)), fixture.token);
  expect(getLocalPlanPolicy(user)).toBe(plan === "lifetime" ? "verified-paid" : "verified-free");
  expect(hasAppEntitlement(user)).toBe(plan === "lifetime");
  expect(fixture.__e2eSkipAccountRefresh).toBe(true);
});

it.each(["none", "lifetime"] as const)("uses the native E2E token namespace for %s", (plan) => {
  expect(firstRunAccountFixture(plan).token.startsWith("e2e-fake-token-")).toBe(true);
});
