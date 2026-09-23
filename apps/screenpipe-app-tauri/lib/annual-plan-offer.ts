// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com

export type AnnualPlanOffer = {
  subscriptionId: string;
  plan: "standard" | "pro";
  annualAmount: number;
  savingsAmount: number;
};

/** Both responses are live, authenticated reads. Never infer cadence from the
 * entitlement's plan label, which is identical for monthly and annual users.
 * change-plan's unitAmount is in USD dollars; billing's amount_cents is cents.
 * These are base rates, before customer discounts and taxes. */
export function getAnnualPlanOffer(billing: any, options: any): AnnualPlanOffer | null {
  const active = billing?.active_subscription;
  const current = options?.current;
  if (
    billing?.subscription_scope !== "personal" ||
    billing?.subscription_status !== "active" ||
    typeof billing?.subscription_id !== "string" ||
    !billing.subscription_id ||
    active?.interval !== "month" ||
    active?.cancel_at_period_end !== false ||
    active?.lifetime !== false ||
    !Number.isSafeInteger(active?.amount_cents) || active.amount_cents <= 0 ||
    current?.interval !== "month" || current?.seats !== 1 ||
    !["standard", "pro"].includes(current?.tier) ||
    billing?.plan !== current.tier ||
    !Array.isArray(options?.targets)
  ) return null;

  const target = options.targets.find((candidate: any) =>
    candidate?.tier === current.tier && candidate?.plan === current.tier &&
    candidate?.interval === "year" && candidate?.perSeat === false &&
    candidate?.requiresSeats === false,
  );
  if (!Number.isFinite(target?.unitAmount) || target.unitAmount <= 0) return null;
  const savingsAmount = Math.round((active.amount_cents * 12 - target.unitAmount * 100)) / 100;
  if (savingsAmount <= 0) return null;
  return {
    subscriptionId: billing.subscription_id,
    plan: current.tier,
    annualAmount: target.unitAmount,
    savingsAmount,
  };
}

export function annualOfferDismissalKey(userId: string, subscriptionId: string) {
  return `screenpipe:annual-plan-dismissed:v1:${userId}:${subscriptionId}`;
}
