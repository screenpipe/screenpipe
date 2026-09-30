// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com
import { beforeEach, afterAll, expect, mock, test } from 'bun:test';
const subject = 'user_capacity_fixture';
const token = 'eyJ.synthetic.capacity';
const originalFetch = globalThis.fetch;
let state;
mock.module('@clerk/backend', () => ({ verifyToken: async () => ({ sub: subject }) }));
globalThis.fetch = async (url, options) => {
  state.calls.push({ url: String(url), body: JSON.parse(options.body) });
  if (String(url) !== 'https://screenpipe.com/api/user') throw new Error('unexpected external port');
  if (state.unavailable) throw new Error('synthetic outage');
  return Response.json(state.body, { status: state.status });
};
const auth = await import('../../../packages/ai-gateway/src/utils/auth');
afterAll(() => { globalThis.fetch = originalFetch; });
const env = { CLERK_SECRET_KEY: 'fixture', AI_GATEWAY_SERVICE_TOKEN: 'fixture-service' };
function user(plan = 'pro', extra = {}) {
  return { id: 'fixture-db-id', clerk_id: subject, cloud_subscribed: true,
    app_entitled: true, subscription_plan: plan,
    entitlement: { plan, active: true, features: { app: true } }, ...extra };
}
beforeEach(() => {
  auth.__resetAuthEntitlementCacheForTests?.();
  state = { calls: [], status: 200, body: { success: true, user: user() } };
});
async function run(credential = token) {
  return auth.validateAuth(new Request('https://gateway.fixture.invalid/usage', { headers: {
    'X-Device-Id': 'fixture-device', ...(credential ? { Authorization: `Bearer ${credential}` } : {}),
  } }), env);
}
async function check(plan, tier = 'subscribed') {
  const value = await run();
  expect(value).toMatchObject({ isValid: true, accountPlan: plan, tier, userId: subject, deviceId: subject });
  expect(value.usageTier ?? value.tier).toBe(tier === 'subscribed' && ['business_max', 'business_ultra'].includes(plan) ? plan : tier);
  for (const call of state.calls) expect(call).toEqual({ url: 'https://screenpipe.com/api/user', body: { token } });
  return value;
}
for (const [billing, plan] of [['pro_max','business_max'],['business_max','business_max'],['pro_ultra','business_ultra'],['business_ultra','business_ultra'],[' PRO_MAX ','business_max']]) {
  test(`canonical ${billing} refines compatible older Business labels`, async () => {
    state.body.user.billing_plan = billing; await check(plan);
  });
}
for (const [label, plan, cloud, tier] of [['standard','basic',false,'logged_in'],['lifetime','basic',false,'logged_in'],['pro','business',true,'subscribed'],['pro_max','business_max',true,'subscribed'],['pro_ultra','business_ultra',true,'subscribed']]) {
  test(`legacy ${label} without billing remains supported`, async () => {
    state.body.user = user(label, { cloud_subscribed: cloud }); await check(plan, tier);
  });
}
for (const [name,billing] of [['null',null],['empty',''],['unknown','premium'],['free','free'],['numeric',9],['object',{}],['basic','standard'],['team','team']]) {
  test(`${name} billing fails capacity closed and retries unknown truth`, async () => {
    state.body.user.billing_plan = billing; await check('unknown'); await check('unknown'); expect(state.calls).toHaveLength(2);
  });
}
test('power billing cannot refine a Basic grant', async () => {
  state.body.user = user('standard', { billing_plan: 'pro_max', cloud_subscribed: false }); await check('unknown','logged_in');
});
for (const name of ['mismatch','missing entitlement','inactive','missing app feature','app denied']) {
  test(`${name} prevents billing data from granting capacity`, async () => {
    const u = state.body.user; u.billing_plan = 'pro_ultra';
    if (name === 'mismatch') u.entitlement.plan = 'standard';
    if (name === 'missing entitlement') delete u.entitlement;
    if (name === 'inactive') u.entitlement.active = false;
    if (name === 'missing app feature') u.entitlement.features = {};
    if (name === 'app denied') u.app_entitled = false;
    await check('unknown');
  });
}
test('explicit fresh denial overrides stale paid labels', async () => {
  state.body.user = user('pro', { billing_plan: 'pro_ultra', app_entitled: false, cloud_subscribed: false }); await check('free','logged_in');
});
for (const name of ['wrong subject','missing subject','unsuccessful','outage','rejected HTTP']) {
  test(`${name} cannot transfer capacity and retries`, async () => {
    state.body.user.billing_plan = 'pro_ultra';
    if (name === 'wrong subject') state.body.user.clerk_id = 'user_other_fixture';
    if (name === 'missing subject') delete state.body.user.clerk_id;
    if (name === 'unsuccessful') state.body.success = false;
    if (name === 'outage') state.unavailable = true;
    if (name === 'rejected HTTP') state.status = 401;
    await check('unknown','logged_in'); await check('unknown','logged_in'); expect(state.calls).toHaveLength(2);
  });
}
test('complete paid truth is cached and bound to the verified caller', async () => {
  state.body.user.billing_plan = 'pro_max'; await check('business_max'); await check('business_max'); expect(state.calls).toHaveLength(1);
});
test('absent credentials remain anonymous without website lookup', async () => {
  expect(await run(null)).toMatchObject({ tier: 'anonymous', accountPlan: 'unknown', deviceId: 'fixture-device' }); expect(state.calls).toHaveLength(0);
});
test('dedicated service credential retains Business access without website lookup', async () => {
  expect(await run(env.AI_GATEWAY_SERVICE_TOKEN)).toMatchObject({ tier: 'subscribed', accountPlan: 'business', service: true }); expect(state.calls).toHaveLength(0);
});
