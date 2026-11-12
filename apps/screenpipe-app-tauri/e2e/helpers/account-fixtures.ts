// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com

// Exact account truth for paid, local-only UI journeys; never send it to cloud.
export function paidAccountFixture(
  scenario: "brain-canvas" | "first-run",
  checkedAt = new Date().toISOString(),
) {
  return {
    id: `e2e-${scenario}-user`,
    email: `e2e-${scenario}@screenpipe.test`,
    token: `e2e-fake-token-${scenario}`,
    __e2eSkipAccountRefresh: true,
    app_entitled: true,
    subscription_plan: "standard",
    entitlement: {
      active: true,
      plan: "standard",
      source: "subscription",
      checked_at: checkedAt,
      features: { app: true, cloud: false },
    },
  };
}

export function paidAccountResponse(user: ReturnType<typeof paidAccountFixture>) {
  return { success: true, user };
}
