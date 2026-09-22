// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com

// Execute the gateway auth boundary; Clerk and website/database responses are
// synthetic ports. This does not test JWT cryptography or live billing.
import { beforeEach, expect, mock, test } from "bun:test";

const UUID = "11111111-1111-4111-8111-111111111111";
const SUBJECT = "user_fixtureVerified";
const VALID_TOKEN = "eyJ.fixture.verified";
const LEGACY_TOKEN = "eyJ.fixture.legacy";
let state;
mock.module("@clerk/backend", () => ({ verifyToken: async (token) => {
  state.verifications.push(token);
  if (state.acceptClerk && token === VALID_TOKEN) return { sub: state.subject };
  throw new Error("synthetic verification rejected");
} }));
globalThis.fetch = async (input) => {
  const url = new URL(String(input));
  state.requests.push(url.href);
  if (state.networkFailure) throw new Error("synthetic provider unavailable");
  if (url.origin === "https://db.fixture.invalid") {
    if (url.pathname === "/rest/v1/users") {
      return Response.json([{ id: UUID, clerk_id: SUBJECT }]);
    }
    if (url.pathname === "/rest/v1/cloud_subscriptions") {
      return Response.json(state.paid ? [{ id: "sub_fixture" }] : []);
    }
  }
  if (url.href === "https://screenpipe.com/api/user") {
    return Response.json(state.website, { status: state.websiteStatus });
  }
  state.unexpected.push(url.origin + url.pathname);
  throw new Error("Unexpected network port; live access is forbidden");
};
const auth = await import("../../../packages/ai-gateway/src/utils/auth");
const env = {
  NODE_ENV: "production",
  CLERK_SECRET_KEY: "synthetic-verifier-key",
  SUPABASE_URL: "https://db.fixture.invalid",
  SUPABASE_ANON_KEY: "synthetic-db-key",
  AI_GATEWAY_SERVICE_TOKEN: "synthetic-machine-credential",
};
function request(token, scheme = "Bearer") {
  return new Request("https://gateway.fixture.invalid/v1/usage", { headers: {
    "X-Device-Id": "device_fixture",
    ...(token ? { Authorization: `${scheme} ${token}` } : {}),
  } });
}
function entitledUser(paid) {
  const plan = paid ? "pro" : "standard";
  return { success: true, user: { id: UUID, clerk_id: SUBJECT,
    cloud_subscribed: paid, app_entitled: true, subscription_plan: plan,
    entitlement: { active: true, plan, features: { app: true, cloud: paid } } } };
}
beforeEach(() => {
  state = { acceptClerk: false, subject: SUBJECT, paid: false, websiteStatus: 200,
    website: { success: false }, networkFailure: false, requests: [], verifications: [], unexpected: [] };
  // Optional cache cleanup allows the same boundary assertions to be checked
  // on current source too; historical implementations need no such helper.
  auth.__resetAuthEntitlementCacheForTests?.();
});
async function result(token, scheme) {
  const value = await auth.validateAuth(request(token, scheme), env);
  expect(state.unexpected).toEqual([]);
  return value;
}
async function anonymous(token, scheme) {
  const value = await result(token, scheme);
  expect(value).toMatchObject({ isValid: true, tier: "anonymous", deviceId: "device_fixture" });
  expect(value.userId).toBeUndefined();
  return value;
}

test("absent credentials retain anonymous access without identity lookup", async () => {
  await anonymous(); expect(state.requests).toEqual([]); expect(state.verifications).toEqual([]);
});
for (const scheme of ["Bearer", "Token"]) {
  for (const token of [UUID, "user_fixturePublic"]) {
    for (const paid of [false, true]) {
      test(`${scheme} public ${token === UUID ? "UUID" : "Clerk ID"}, paid=${paid}, cannot authenticate`, async () => {
        state.paid = paid;
        await anonymous(token, scheme);
        expect(state.requests).toEqual([]);
      });
    }
  }
  for (const paid of [false, true]) {
    test(`${scheme} verified caller retains ${paid ? "subscribed" : "logged_in"} access`, async () => {
      state.acceptClerk = true; state.paid = paid; state.website = entitledUser(paid);
      expect(await result(VALID_TOKEN, scheme)).toMatchObject({ isValid: true,
        tier: paid ? "subscribed" : "logged_in", userId: SUBJECT, deviceId: SUBJECT });
      expect(state.verifications).toContain(VALID_TOKEN);
    });
  }
}
for (const [name, subject] of [["missing", undefined], ["null", null], ["empty", ""], ["numeric", 42], ["object", {}]]) {
  test(`verified-provider response with ${name} subject cannot authenticate`, async () => {
    state.acceptClerk = true; state.subject = subject; await anonymous(VALID_TOKEN);
  });
}
for (const [name, website] of [
  ["unsuccessful", { success: false, user: { clerk_id: SUBJECT, cloud_subscribed: true } }],
  ["missing success", { user: { clerk_id: SUBJECT, cloud_subscribed: true } }],
  ["missing user", { success: true }],
  ["missing identity", { success: true, user: { cloud_subscribed: true } }],
]) {
  test(`HTTP 200 website response with ${name} cannot authenticate`, async () => {
    state.website = website; await anonymous(LEGACY_TOKEN);
  });
}
for (const paid of [false, true]) {
  test(`validated legacy token retains ${paid ? "subscribed" : "logged_in"} access`, async () => {
    state.website = entitledUser(paid);
    expect(await result(LEGACY_TOKEN)).toMatchObject({ isValid: true,
      tier: paid ? "subscribed" : "logged_in", userId: SUBJECT, deviceId: SUBJECT });
  });
}
test("unavailable legacy validation does not manufacture an identity", async () => {
  state.networkFailure = true; await anonymous(LEGACY_TOKEN);
});
test("rejected legacy HTTP response cannot grant access", async () => {
  state.website = entitledUser(true); state.websiteStatus = 401; await anonymous(LEGACY_TOKEN);
});
test("arbitrary token remains anonymous", async () => {
  await anonymous("synthetic-invalid-credential"); expect(state.requests).toEqual([]);
});
test("unrecognized long credential cannot authenticate", async () => {
  await anonymous(env.AI_GATEWAY_SERVICE_TOKEN + "-wrong");
});
