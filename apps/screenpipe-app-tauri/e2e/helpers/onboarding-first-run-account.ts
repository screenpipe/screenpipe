// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com

export function firstRunAccountFixture(plan: "none" | "lifetime", checkedAt = new Date().toISOString()) {
  const lifetime = plan === "lifetime";
  const account = lifetime ? "lifetime-owner" : "free-user";
  return {
    id: `e2e-${account}`,
    clerk_id: `e2e-${account}`,
    token: `e2e-fake-token-${account}`,
    email: `${account}@screenpipe.test`,
    __e2eSkipAccountRefresh: true,
    cloud_subscribed: false,
    app_entitled: lifetime,
    subscription_plan: plan,
    entitlement_source: plan,
    has_payment_method: false,
    entitlement: {
      active: lifetime,
      plan,
      source: plan,
      checked_at: checkedAt,
      features: { app: lifetime, cloud: lifetime },
    },
  };
}
