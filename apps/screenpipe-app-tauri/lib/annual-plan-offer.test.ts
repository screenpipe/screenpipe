// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com
import { describe, expect, it } from "vitest";
import { annualOfferDismissalKey, getAnnualPlanOffer } from "./annual-plan-offer";

export const billing = {
  subscription_scope: "personal", subscription_status: "active", subscription_id: "sub-fixture",
  plan: "pro", active_subscription: { interval: "month", amount_cents: 5000, cancel_at_period_end: false, lifetime: false },
};
export const options = {
  current: { tier: "pro", interval: "month", seats: 1 },
  targets: [{ plan: "pro", tier: "pro", interval: "year", unitAmount: 500, perSeat: false, requiresSeats: false }],
};
describe("annual plan eligibility", () => {
  it("uses the live same-tier annual target and converts cents once", () => {
    expect(getAnnualPlanOffer(billing, options)).toEqual({ subscriptionId: "sub-fixture", plan: "pro", annualAmount: 500, savingsAmount: 100 });
    expect(getAnnualPlanOffer({ ...billing, plan: "standard", active_subscription: { ...billing.active_subscription, amount_cents: 2500 } }, { current: { tier: "standard", interval: "month", seats: 1 }, targets: [{ ...options.targets[0], plan: "standard", tier: "standard", unitAmount: 250 }] })?.savingsAmount).toBe(50);
  });
  it.each(["trialing", "past_due", "unpaid", "canceled", "incomplete"])("hides %s accounts", status => {
    expect(getAnnualPlanOffer({ ...billing, subscription_status: status }, options)).toBeNull();
  });
  it.each([
    { interval: "year" }, { interval: null }, { cancel_at_period_end: true }, { lifetime: true },
    { amount_cents: null }, { amount_cents: 0 }, { amount_cents: 1000 },
  ])("hides ineligible billing snapshots %j", active => {
    expect(getAnnualPlanOffer({ ...billing, active_subscription: { ...billing.active_subscription, ...active } }, options)).toBeNull();
  });
  it.each(["workspace", "grant", null])("hides scope %s", scope => {
    expect(getAnnualPlanOffer({ ...billing, subscription_scope: scope }, options)).toBeNull();
  });
  it("does not invent prices or upsell a different tier", () => {
    for (const data of [null, {}, { ...options, targets: [] }, { ...options, current: { ...options.current, interval: "year" } }, { ...options, current: { ...options.current, seats: 5 } }, { ...options, targets: [{ ...options.targets[0], tier: "standard" }] }, { ...options, targets: [{ ...options.targets[0], unitAmount: "500" }] }]) {
      expect(getAnnualPlanOffer(billing, data)).toBeNull();
    }
    expect(getAnnualPlanOffer(null, options)).toBeNull();
  });
  it("scopes dismissal to the account and subscription, not the price", () => {
    expect(annualOfferDismissalKey("a", "one")).not.toBe(annualOfferDismissalKey("b", "one"));
    expect(annualOfferDismissalKey("a", "one")).not.toBe(annualOfferDismissalKey("a", "two"));
  });
});
