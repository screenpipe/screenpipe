// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com

import { describe, expect, it, vi, afterEach } from "vitest";
import { paidAccountFixture, paidAccountResponse } from "../../e2e/helpers/account-fixtures";
import {
  getLocalPlanPolicy,
  hasAppEntitlement,
  hasCloudEntitlement,
  needsAppEntitlementRefresh,
  normalizeAppUser,
} from "../app-entitlement";

// Catch fixtures that turn a paid UI journey into unknown/free access, lose
// their no-network marker, or use credentials native E2E mode rejects.
describe("desktop paid account fixtures", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  for (const scenario of ["brain-canvas", "first-run"] as const) {
    it(`${scenario} remains paid and local-only after account normalization`, () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2026-11-11T20:00:00.000Z"));
      const fixture = paidAccountFixture(scenario);
      const persisted = JSON.parse(JSON.stringify(fixture));
      const account = normalizeAppUser(persisted, persisted.token);
      expect(getLocalPlanPolicy(account)).toBe("verified-paid");
      expect(hasAppEntitlement(account)).toBe(true);
      expect(hasCloudEntitlement(account)).toBe(false);
      expect(needsAppEntitlementRefresh(account)).toBe(false);
      expect(persisted.__e2eSkipAccountRefresh).toBe(true);
    });
  }

  it.each(["brain-canvas", "first-run"] as const)("%s uses credentials accepted by native E2E mode", (scenario) => {
    // auth_token::is_cloud_session_token permits this synthetic namespace
    // only in native E2E mode. Never substitute public account identifiers.
    expect(paidAccountFixture(scenario).token.startsWith("e2e-fake-token-")).toBe(true);
  });

  it("the account response carries the user consumed by loadUser", () => {
    const fixture = paidAccountFixture("brain-canvas");
    const response = JSON.parse(JSON.stringify(paidAccountResponse(fixture)));
    expect(response.success).toBe(true);
    expect(response.user).toBeDefined();
    const account = normalizeAppUser(response.user, fixture.token);
    expect(getLocalPlanPolicy(account)).toBe("verified-paid");
    expect(hasAppEntitlement(account)).toBe(true);
  });
});
