// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com
// Actual auth entry points with synthetic verifier and network ports.
import { afterEach, beforeEach, expect, mock, test } from "bun:test";
import { inspect } from "node:util";
const JWT = "eyJ.syntheticCredentialCanary.signature";
const SUBJECT = "user_SyntheticSubjectCanary";
const EMAIL = "synthetic-email-canary@example.invalid";
const UUID = "11111111-1111-4111-8111-111111111111";
const ERROR = "synthetic-upstream-detail-canary";
const env = { NODE_ENV: "production", CLERK_SECRET_KEY: "synthetic-secret-key",
  SUPABASE_URL: "https://db.fixture.invalid", SUPABASE_ANON_KEY: "synthetic-db-key" };
let state;
mock.module("@clerk/backend", () => ({ verifyToken: async (token, options) => {
  state.verifications.push({ token, options });
  if (state.accept) return { sub: SUBJECT };
  throw new Error(ERROR);
} }));
globalThis.fetch = async (input) => {
  const url = new URL(String(input)); state.requests.push(url.href);
  if (state.networkFailure) throw new Error(ERROR);
  if (url.origin === env.SUPABASE_URL) {
    if (url.pathname === "/rest/v1/users") return Response.json([{ id: UUID, clerk_id: SUBJECT }]);
    if (url.pathname === "/rest/v1/cloud_subscriptions") return Response.json(state.paid ? [{ id: "synthetic-subscription" }] : []);
  }
  if (url.href === "https://screenpipe.com/api/user") {
    const plan = state.paid ? "pro" : "standard";
    return Response.json({ success: true, user: { id: UUID, clerk_id: SUBJECT, email: EMAIL,
      cloud_subscribed: state.paid, app_entitled: true, subscription_plan: plan,
      entitlement: { active: true, plan, features: { app: true, cloud: state.paid } } } },
      { status: state.websiteStatus });
  }
  state.unexpected.push(url.origin + url.pathname);
  throw new Error("Unexpected synthetic port");
};
const auth = await import("../../../packages/ai-gateway/src/utils/auth");
const originals = Object.fromEntries(["log", "error", "warn", "info", "debug"].map(k => [k, console[k]]));
beforeEach(() => {
  state = { accept: false, paid: false, websiteStatus: 200, networkFailure: false,
    requests: [], verifications: [], unexpected: [], logs: [] };
  auth.__resetAuthEntitlementCacheForTests?.();
  for (const k of Object.keys(originals)) console[k] = (...args) => state.logs.push(args.map(v => inspect(v, { depth: 8 })).join(" "));
});
afterEach(() => { for (const [k, value] of Object.entries(originals)) console[k] = value; });
function request(token = JWT, scheme = "Bearer") {
  return new Request("https://gateway.fixture.invalid/v1/usage", { headers: {
    "X-Device-Id": "synthetic-device", ...(token ? { Authorization: `${scheme} ${token}` } : {}) } });
}
async function result(token = JWT, scheme) {
  const value = await auth.validateAuth(request(token, scheme), env);
  expect(state.unexpected).toEqual([]); return value;
}
function privateLogs() {
  const output = state.logs.join("\n");
  for (const secret of [JWT, SUBJECT, EMAIL, UUID, ERROR, env.CLERK_SECRET_KEY, env.SUPABASE_ANON_KEY]) expect(output).not.toContain(secret);
}
function identity(value, paid) {
  expect(value).toMatchObject({ isValid: true, userId: SUBJECT, deviceId: SUBJECT,
    tier: paid ? "subscribed" : "logged_in" });
}
function anonymous(value) {
  expect(value).toMatchObject({ isValid: true, tier: "anonymous", deviceId: "synthetic-device" });
  expect(value.userId).toBeUndefined();
}
for (const accept of [true, false]) test(`Clerk verification preserves result and private logs, accepted=${accept}`, async () => {
  state.accept = accept;
  expect(await auth.verifyClerkToken(env, JWT)).toEqual(accept ? { valid: true, userId: SUBJECT } : { valid: false });
  expect(state.verifications).toEqual([{ token: JWT, options: { secretKey: env.CLERK_SECRET_KEY } }]);
  privateLogs();
});
for (const accept of [true, false]) for (const paid of [true, false]) test(`${accept ? "verified" : "legacy"} identity keeps tier and private logs, paid=${paid}`, async () => {
  state.accept = accept; state.paid = paid; identity(await result(), paid);
  expect(state.verifications.length).toBeGreaterThan(0);
  expect(state.requests.length).toBeGreaterThan(0); privateLogs();
});
test("provider exception keeps anonymous fallback and private logs", async () => {
  state.networkFailure = true; anonymous(await result());
  expect(state.requests).toContain("https://screenpipe.com/api/user"); privateLogs();
});
test("rejected website response keeps anonymous fallback and private logs", async () => {
  state.websiteStatus = 401; anonymous(await result()); privateLogs();
});
test("missing credentials preserve device identity without verifier or network", async () => {
  anonymous(await result(null)); expect(state.verifications).toEqual([]); expect(state.requests).toEqual([]); privateLogs();
});
test("Bearer and Token retain verified paid and free identity", async () => {
  state.accept = true;
  for (const scheme of ["Bearer", "Token"]) for (const paid of [true, false]) {
    auth.__resetAuthEntitlementCacheForTests?.(); state.paid = paid; identity(await result(JWT, scheme), paid);
  }
});
test("legacy validation retains authenticated paid and free identity", async () => {
  for (const paid of [true, false]) { state.paid = paid; identity(await result(), paid); }
});
test("invalid credential preserves anonymous fallback", async () => {
  anonymous(await result("synthetic-invalid-credential")); expect(state.requests).toEqual([]);
});
