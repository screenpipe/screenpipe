// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com

import { afterEach, beforeEach, expect, mock, setSystemTime, test } from "bun:test";

// Only URL configuration is substituted. Account normalization and policy
// classification execute the historical product module, with a fixed clock.
mock.module("@/lib/web-url", () => ({
  screenpipeWebUrl: (path: string) => `https://fixture.invalid${path}`,
}));
const {
  normalizeAppUser,
  getLocalPlanPolicy,
  hasConsumerAppSubscription,
  hasCloudEntitlement,
} = await import("../../../apps/screenpipe-app-tauri/lib/app-entitlement");

const NOW = new Date("2026-06-05T12:00:00.000Z");
const originalForceGate = process.env.NEXT_PUBLIC_SCREENPIPE_FORCE_BILLING_GATE;
beforeEach(() => {
  setSystemTime(NOW);
  process.env.NEXT_PUBLIC_SCREENPIPE_FORCE_BILLING_GATE = "true";
});
afterEach(() => {
  setSystemTime();
  if (originalForceGate === undefined) delete process.env.NEXT_PUBLIC_SCREENPIPE_FORCE_BILLING_GATE;
  else process.env.NEXT_PUBLIC_SCREENPIPE_FORCE_BILLING_GATE = originalForceGate;
});

function account(plan = "pro_ultra", cloud = true) {
  return {
    id: "synthetic-account",
    app_entitled: true,
    cloud_subscribed: cloud,
    entitlement: {
      active: true,
      plan,
      source: plan === "lifetime" ? "lifetime" : "subscription",
      checked_at: NOW.toISOString(),
      features: { app: true, cloud },
    },
  };
}

for (const [plan, cloud] of [["lifetime", false], ["pro_max", true], ["pro_ultra", true]] as const) {
  for (const absent of ["omitted", "null"] as const) {
    test(`${plan} stays verified when top-level plan is ${absent}`, () => {
      const raw = account(plan, cloud);
      const normalized = normalizeAppUser(absent === "null" ? { ...raw, subscription_plan: null } : raw, "synthetic-token");
      expect(getLocalPlanPolicy(normalized)).toBe("verified-paid");
      expect(normalized.subscription_plan).toBe(plan);
      expect(normalized.id).toBe("synthetic-account");
      expect(normalized.token).toBe("synthetic-token");
      expect(hasConsumerAppSubscription(normalized)).toBe(true);
      expect(hasCloudEntitlement(normalized)).toBe(cloud);
    });
  }
}

test("explicit conflicting server plan retains precedence and stays unknown", () => {
  const normalized = normalizeAppUser({ ...account(), subscription_plan: "standard" }, "synthetic-token");
  expect(normalized.subscription_plan).toBe("standard");
  expect(getLocalPlanPolicy(normalized)).toBe("unknown");
  expect(hasConsumerAppSubscription(normalized)).toBe(false);
});

test("an explicit empty plan is not treated as an omitted plan", () => {
  const normalized = normalizeAppUser({ ...account(), subscription_plan: "" }, "synthetic-token");
  expect(normalized.subscription_plan).toBe("");
  expect(getLocalPlanPolicy(normalized)).toBe("unknown");
});

test("explicit app denial without cloud subscription remains free", () => {
  const normalized = normalizeAppUser({ ...account("lifetime", false), app_entitled: false }, "synthetic-token");
  expect(normalized.subscription_plan).toBe("none");
  expect(getLocalPlanPolicy(normalized)).toBe("verified-free");
  expect(hasConsumerAppSubscription(normalized)).toBe(false);
  expect(hasCloudEntitlement(normalized)).toBe(false);
});

for (const cloud of [false, true]) {
  test(`legacy boolean-only evidence keeps its ${cloud ? "pro" : "standard"} fallback`, () => {
    const normalized = normalizeAppUser({ id: "synthetic-account", app_entitled: true, cloud_subscribed: cloud }, "synthetic-token");
    expect(normalized.subscription_plan).toBe(cloud ? "pro" : "standard");
    expect(getLocalPlanPolicy(normalized)).toBe("verified-paid");
    expect(hasConsumerAppSubscription(normalized)).toBe(true);
    expect(hasCloudEntitlement(normalized)).toBe(cloud);
  });
}

for (const invalidPlan of [null, "   ", 42]) {
  test(`malformed entitlement plan ${JSON.stringify(invalidPlan)} cannot establish paid policy`, () => {
    const raw = account();
    const normalized = normalizeAppUser({ ...raw, entitlement: { ...raw.entitlement, plan: invalidPlan } }, "synthetic-token");
    expect(normalized.subscription_plan).toBe("pro");
    expect(getLocalPlanPolicy(normalized)).toBe("unknown");
    expect(hasConsumerAppSubscription(normalized)).toBe(false);
  });
}

for (const invalidEvidence of ["stale", "future", "inactive"] as const) {
  test(`${invalidEvidence} non-lifetime evidence remains unknown after normalization`, () => {
    const raw = account();
    if (invalidEvidence === "stale") raw.entitlement.checked_at = "2026-06-01T12:00:00.000Z";
    if (invalidEvidence === "future") raw.entitlement.checked_at = "2026-06-06T12:00:00.000Z";
    if (invalidEvidence === "inactive") raw.entitlement.active = false;
    const normalized = normalizeAppUser(raw, "synthetic-token");
    expect(getLocalPlanPolicy(normalized)).toBe("unknown");
    expect(hasConsumerAppSubscription(normalized)).toBe(false);
    expect(hasCloudEntitlement(normalized)).toBe(false);
  });
}

test("enterprise evidence is not a consumer subscription", () => {
  const raw = account("enterprise");
  raw.entitlement.source = "enterprise";
  const normalized = normalizeAppUser({ ...raw, subscription_plan: "enterprise" }, "synthetic-token");
  expect(getLocalPlanPolicy(normalized)).toBe("verified-paid");
  expect(hasConsumerAppSubscription(normalized)).toBe(false);
});

test("missing stable identity cannot establish verified paid policy", () => {
  const normalized = normalizeAppUser({ ...account(), id: "" }, "synthetic-token");
  expect(getLocalPlanPolicy(normalized)).toBe("unknown");
  expect(hasConsumerAppSubscription(normalized)).toBe(false);
});
