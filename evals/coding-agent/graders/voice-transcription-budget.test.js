// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com
import { beforeEach, afterEach, afterAll, expect, mock, setSystemTime, test } from 'bun:test';
import { Database } from 'bun:sqlite';
let state, serial = 0;
const originalFetch = globalThis.fetch;
mock.module('@clerk/backend', () => ({ verifyToken: async () => ({ sub: state.subject }) }));
mock.module('@deepgram/sdk', () => ({
  createClient: () => ({ listen: { prerecorded: {
    transcribeFile: async (body, options) => {
      state.provider.push({ body: Buffer.from(body), options });
      return { result: { results: { channels: [{ alternatives: [{
        transcript: 'synthetic transcript', confidence: 0.9, words: [],
      }] }] } }, error: null };
    },
  } } }),
}));
const { handleRequest } = await import('../../../packages/ai-gateway/src/index');
const { __resetAuthEntitlementCacheForTests: reset } = await import('../../../packages/ai-gateway/src/utils/auth');
const { privateCostControls } = await import('../../../packages/ai-gateway/src/test/fixtures/private-cost-controls');
const audio = Buffer.from([82, 73, 70, 70, 4, 0, 0, 0, 87, 65, 86, 69]);
function environment() {
  return {
    ...privateCostControls(), MAX_GLOBAL_HOURLY_TRANSCRIPTION_COST: '501', MAX_GLOBAL_DAILY_TRANSCRIPTION_COST: '502',
    NODE_ENV: 'production', CLERK_SECRET_KEY: 'synthetic', DEEPGRAM_API_KEY: 'synthetic',
    RATE_LIMITER: { idFromName: x => x, get: () => ({ fetch: async () => Response.json({
      allowed: true, standing: 'good', remaining: 10, reset_in: 60, tier: 'logged_in', rpm_limit: 25,
    }) }) },
    // Execute budget queries against seeded SQLite rows, accepting equivalent SQL.
    // Telemetry writes are inert ports; settlement durability is outside this case.
    DB: { prepare: sql => ({ bind: (...args) => ({
      first: async () => {
        if (state.fail) throw Error('synthetic D1 unavailable');
        return state.db.query(sql).get(...args);
      },
      all: async () => ({ results: state.db.query(sql).all(...args) }),
      run: async () => ({ success: true }),
    }) }), batch: async () => [] },
  };
}
beforeEach(() => {
  reset?.();
  setSystemTime(new Date("2026-01-02T12:00:00Z"));
  state = { subject: `user_voice_${++serial}`, provider: [], reads: [], pending: [], account: 0, hourly: 0, daily: 0, fail: false };
  state.db = new Database(':memory:');
  state.db.run('CREATE TABLE usage (device_id TEXT PRIMARY KEY, last_reset TEXT, cost_day TEXT, daily_cost_usd REAL)');
  globalThis.fetch = async input => {
    if (String(input) === 'https://screenpipe.com/api/user') return Response.json({ success: true, user: {
      clerk_id: state.subject, cloud_subscribed: true, app_entitled: true, subscription_plan: 'pro',
      entitlement: { active: true, plan: 'pro', features: { app: true, cloud: true } },
    } });
    throw Error('Unexpected network port');
  };
});
afterEach(() => { state.db.close(); });
afterAll(() => { globalThis.fetch = originalFetch; setSystemTime(); });
async function request(type = 'audio/wav') {
  const insert = state.db.query('INSERT INTO usage VALUES (?, ?, ?, ?)');
  insert.run(`hosted-transcription-cost:day:v1:${state.subject}`, '2026-01-02', '2026-01-02', state.account);
  insert.run('hosted-transcription-cost:global-hour:v1:2026-01-02T12', '2026-01-02T12', '2026-01-02T12', state.hourly);
  insert.run('hosted-transcription-cost:global-hour:v1:2026-01-02T11', '2026-01-02T11', '2026-01-02T11', Math.max(0, state.daily - state.hourly));
  const response = await handleRequest(new Request('https://gateway.example.invalid/v1/voice/transcribe', {
    method: 'POST', headers: { 'content-type': type, authorization: 'Bearer eyJ.synthetic.voice' }, body: audio,
  }), environment(), { waitUntil: promise => state.pending.push(promise), passThroughOnException: () => {} });
  await Promise.all(state.pending);
  return response;
}
async function refuse(status) {
  const response = await request(); expect(response.status).toBe(status); expect(state.provider).toEqual([]);
}
test('account exhaustion refuses before provider', async () => { state.account = 103; await refuse(429); });
test('global hour exhaustion refuses before provider', async () => { state.hourly = 501; await refuse(429); });
test('global day exhaustion refuses before provider', async () => { state.daily = 502; await refuse(429); });
test('unknown accounting refuses before provider', async () => { state.fail = true; await refuse(503); });
test('in-budget request preserves provider body and transcript', async () => {
  const response = await request(); expect(response.status).toBe(200); expect(state.provider).toHaveLength(1);
  expect(state.provider[0].body).toEqual(audio); expect(await response.json()).toMatchObject({ transcription: 'synthetic transcript' });
});
test('invalid audio type preserves refusal', async () => {
  const response = await request('application/json'); expect(response.status).toBe(400); expect(state.provider).toEqual([]);
});
test('spend immediately below every cap remains eligible', async () => {
  state.account = 102.999; state.hourly = 500.999; state.daily = 501.999;
  const response = await request(); expect(response.status).toBe(200); expect(state.provider).toHaveLength(1);
  expect(state.provider[0].body).toEqual(audio);
});
