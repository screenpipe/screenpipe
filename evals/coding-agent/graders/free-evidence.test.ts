// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com
import { afterEach, beforeEach, expect, mock, setSystemTime, test } from "bun:test";
mock.module("@/lib/web-url", () => ({ screenpipeWebUrl: (p: string) => `https://fixture.invalid${p}` }));
const { normalizeAppUser, getLocalPlanPolicy, isAuthenticatedFreeUser, hasVerifiedPaidPlan, hasAppEntitlement } = await import("../../../apps/screenpipe-app-tauri/lib/app-entitlement");
const NOW = new Date("2026-06-05T12:00:00Z");
const oldGate = process.env.NEXT_PUBLIC_SCREENPIPE_FORCE_BILLING_GATE;
beforeEach(() => { setSystemTime(NOW); process.env.NEXT_PUBLIC_SCREENPIPE_FORCE_BILLING_GATE = "true"; });
afterEach(() => { setSystemTime(); if (oldGate === undefined) delete process.env.NEXT_PUBLIC_SCREENPIPE_FORCE_BILLING_GATE; else process.env.NEXT_PUBLIC_SCREENPIPE_FORCE_BILLING_GATE = oldGate; });
const legacy = () => ({ id: "fixture-owner", cloud_subscribed: false });
const free = () => ({ id: "fixture-owner", token: "fixture-token", cloud_subscribed: false, subscription_plan: "none", entitlement: { active: true, plan: "none", source: "none", checked_at: NOW.toISOString(), features: { app: true, cloud: false } } });
test("complete legacy denial normalizes to authenticated free without paid app access", () => {
 const u = normalizeAppUser(legacy(), "fixture-token");
 expect(getLocalPlanPolicy(u)).toBe("verified-free"); expect(isAuthenticatedFreeUser(u)).toBe(true);
 expect(hasVerifiedPaidPlan(u)).toBe(false); expect(hasAppEntitlement(u)).toBe(false);
 expect(u.id).toBe("fixture-owner"); expect(u.token).toBe("fixture-token");
});
for (const entitlement of [{ plan: "none" }, { active: false, plan: "none", source: "none" }]) {
 test(`partial newer evidence stays unknown: ${JSON.stringify(entitlement)}`, () => {
  const u=normalizeAppUser({...legacy(),entitlement},"fixture-token");expect(getLocalPlanPolicy(u)).toBe("unknown");expect(isAuthenticatedFreeUser(u)).toBe(false);
 });
}
for (const field of ["app_entitled", "subscription_plan", "entitlement"]) {
 test(`explicit null ${field} is not a legacy omission`, () => { const u=normalizeAppUser({...legacy(),[field]:null},"fixture-token");expect(getLocalPlanPolicy(u)).toBe("unknown"); });
}
for (const token of ["", "   ", null]) {
 test(`token ${JSON.stringify(token)} cannot authenticate cached free policy`, () => { const u={...free(),token};expect(getLocalPlanPolicy(u)).toBe("verified-free");expect(isAuthenticatedFreeUser(u as any)).toBe(false); });
}
for (const active of [true,false]) {
 test(`complete newer free evidence with app=${active} remains free offline`, () => { const u=free();u.entitlement={...u.entitlement,active,checked_at:"2026-05-01T00:00:00Z",features:{app:active,cloud:false}};expect(getLocalPlanPolicy(u)).toBe("verified-free");expect(isAuthenticatedFreeUser(u)).toBe(true); });
}
for (const cloud of [undefined,null,true]) {
 test(`cloud denial must be explicit: ${cloud}`, () => {expect(getLocalPlanPolicy({...free(),cloud_subscribed:cloud} as any)).toBe("unknown");});
}
for (const source of ["subscription","unexpected","manual","enterprise","lifetime","dev"]) {
 test(`source ${source} cannot establish free policy`, () => {const u=free();u.entitlement.source=source;expect(getLocalPlanPolicy(u)).toBe("unknown");});
}
test("cloud feature, future timestamps and grace do not establish free policy", () => {
 for(const patch of [{features:{app:true,cloud:true}},{checked_at:"2027-01-01T00:00:00Z"},{grace_until:"2026-06-06T12:00:00Z"}]) { const u=free();expect(getLocalPlanPolicy({...u,entitlement:{...u.entitlement,...patch}})).toBe("unknown"); }
});
test("stable identity is required and clerk fallback stays valid",()=>{
 expect(getLocalPlanPolicy(normalizeAppUser({...legacy(),id:"   "},"fixture-token"))).toBe("unknown");
 const u=normalizeAppUser({...legacy(),id:"   ",clerk_id:"fixture-clerk"},"fixture-token");expect(getLocalPlanPolicy(u)).toBe("verified-free");expect(u.clerk_id).toBe("fixture-clerk");
});
test("explicit denial still overrides stale paid label",()=>{const u=normalizeAppUser({...legacy(),app_entitled:false,subscription_plan:"standard"},"fixture-token");expect(getLocalPlanPolicy(u)).toBe("verified-free");expect(hasVerifiedPaidPlan(u)).toBe(false);});
for(const plan of ["standard","pro","lifetime"]) {
 test(`preserve valid ${plan} paid policy`,()=>{const u=normalizeAppUser({id:"fixture-owner",app_entitled:true,cloud_subscribed:plan==="pro",subscription_plan:plan,entitlement:{active:true,plan,source:plan==="lifetime"?"lifetime":"subscription",checked_at:NOW.toISOString(),features:{app:true,cloud:plan==="pro"}}},"fixture-token");expect(getLocalPlanPolicy(u)).toBe("verified-paid");expect(hasVerifiedPaidPlan(u)).toBe(true);expect(isAuthenticatedFreeUser(u)).toBe(false);});
}
