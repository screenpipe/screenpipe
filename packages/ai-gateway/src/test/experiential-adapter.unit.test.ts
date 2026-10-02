// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com
import { describe, expect, it } from 'bun:test';
import { prepareExperientialProbeConnection, type ExperientialAdapterOptions } from '../../scripts/lib/experiential-adapter';
import { EXPERIENTIAL_ORIGIN } from '../../scripts/lib/experiential-migration';
import { hostedChatActorId } from '../services/cloudflare-ai-gateway';

const org = '00000000-0000-0000-0000-000000000001';
const identity = 'customer-alice';
const provisioner = 'entitlement-sync';
const canonical = '00000000-0000-0000-0000-000000000004';
const customerKey = `xpl_${'0'.repeat(40)}`;
const managementKey = `xpl_${'1'.repeat(40)}`;
const model = 'gpt-5.4-mini';
const expectedPlan = { plan_key: 'business', plan_version: 1, revision: 1 };
const auth = { isValid: true, tier: 'subscribed', accountPlan: 'business', userId: 'synthetic-user', deviceId: 'synthetic-device' } as const;
async function fixture(overrides: { capture?: boolean; policy?: Record<string, unknown>; entitled?: boolean | null; modelPolicy?: Record<string, unknown>; verdict?: string | null; who?: Record<string, unknown>; status?: number; catalog?: string[]; binding?: Record<string, any> } = {}) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const actorId = await hostedChatActorId(auth);
  const options: ExperientialAdapterOptions = {
    mode: 'isolated-test', auth, sourceModelId: model, managementKey,
    mappings: [{ sourceModelId: model, destinationModelId: model, canonicalModelUuid: canonical, protocol: 'chat' }],
    lookupBinding: async () => ({ actorId, orgId: org, customerIdentityId: identity, provisioningIdentityId: provisioner, accountPlan: 'business', expectedPlan, customerKey, ...overrides.binding }),
    transport: async (url, init) => {
      calls.push({ url, init });
      const management = new Headers(init.headers).get('Authorization') === `Bearer ${managementKey}`;
      if (init.method === 'POST') return Response.json({ choices: [{ message: { content: 'OK' } }] }, { status: overrides.status ?? 200, headers: overrides.verdict === null ? {} : { 'x-gateway-zdr': overrides.verdict ?? 'true' } });
      if (url.endsWith('/api/whoami')) return Response.json(management ? { org_id: org } : { org_id: org, identity_id: identity, customer_plan_identity_id: identity, is_provisioning: false, ...overrides.who });
      if (url.endsWith('/v1/models')) return Response.json({ data: (overrides.catalog ?? [model]).map(id => ({ id, data_policy: overrides.modelPolicy ?? { zdr_on_request: true } })) });
      if (url.endsWith(`/identities/${identity}/customer-plan`) && !management) return Response.json({ org_id: org, identity_id: identity, ...expectedPlan, pending_plan_key: null, pending_plan_version: null, pending_effective_at: null });
      if (!management) throw new Error('customer key must not read management privacy settings');
      if (url.endsWith(`/api/models/${model}`)) return Response.json({ model: { id: canonical, slug: model } });
      if (url.endsWith('/telemetry-settings')) return Response.json({ capture_prompt_content: overrides.capture ?? false });
      if (url.endsWith('/provider-policy')) return Response.json({ zdr_entitled: overrides.entitled === undefined ? true : overrides.entitled, policy: { require_no_training: true, zdr_continuation_storage: false, ...overrides.policy } });
      throw new Error('unexpected request');
    },
  };
  return { calls, options };
}
const post = (modelId = model, headers?: Record<string, string>) => ({ method: 'POST', body: JSON.stringify({ model: modelId, max_completion_tokens: 64, messages: [{ role: 'user', content: 'Synthetic.' }] }), headers });
const url = `${EXPERIENTIAL_ORIGIN}/v1/chat/completions`;

describe('inactive customer-isolated adapter', () => {
  it.each([undefined, 'inactive'] as const)('does nothing in mode %s', async mode => {
    const { options, calls } = await fixture();
    await expect(prepareExperientialProbeConnection({ ...options, mode })).rejects.toMatchObject({ code: 'experiential_adapter_inactive' });
    expect(calls).toHaveLength(0);
  });
  it.each([
    { isValid: false }, { accountPlan: 'unknown' }, { userId: '' }, { service: true },
  ])('rejects unverified entitlement locally %j', async change => {
    const { options, calls } = await fixture();
    await expect(prepareExperientialProbeConnection({ ...options, auth: { ...auth, ...change } as any })).rejects.toMatchObject({ code: 'verified_customer_entitlement_required' });
    expect(calls).toHaveLength(0);
  });
  it('rejects source-plan escalation and absent registry entries before any HTTP', async () => {
    const { options, calls } = await fixture();
    await expect(prepareExperientialProbeConnection({ ...options, auth: { ...auth, accountPlan: 'basic' }, sourceModelId: 'claude-opus-5' })).rejects.toMatchObject({ code: 'model_not_allowed_for_source_plan' });
    await expect(prepareExperientialProbeConnection({ ...options, lookupBinding: async () => null })).rejects.toMatchObject({ code: 'customer_binding_missing' });
    expect(calls).toHaveLength(0);
  });
  it.each(['auto', 'glm-5.3-flash-reap50-iq3m', 'screenpipe-event-classifier'])('never migrates the separate route %s', async sourceModelId => {
    const { options, calls } = await fixture();
    await expect(prepareExperientialProbeConnection({ ...options, sourceModelId })).rejects.toMatchObject({ code: 'separate_route_not_migrated' });
    expect(calls).toHaveLength(0);
  });
  it.each(['missing', 'duplicate', 'substitution', 'wrong-protocol', 'invalid-uuid'])('rejects %s model mapping before a request', async failure => {
    const { options, calls } = await fixture();
    const mapping = { ...options.mappings[0] };
    if (failure === 'substitution') mapping.destinationModelId = 'gpt-5.4-nano';
    if (failure === 'wrong-protocol') mapping.protocol = 'messages';
    if (failure === 'invalid-uuid') mapping.canonicalModelUuid = model;
    options.mappings = failure === 'missing' ? [] : failure === 'duplicate' ? [mapping, mapping] : [mapping];
    await expect(prepareExperientialProbeConnection(options)).rejects.toBeDefined(); expect(calls).toHaveLength(0);
  });
  it.each([
    { actorId: 'another-actor' }, { accountPlan: 'business_max' }, { customerIdentityId: provisioner }, { customerKey: managementKey },
    { customerIdentityId: '00000000-0000-0000-0000-000000000002' }, { customerIdentityId: '../customer-alice' }, { customerIdentityId: 'Customer-Alice' },
  ])('rejects stale or shared binding %j', async binding => {
    const { options, calls } = await fixture({ binding });
    await expect(prepareExperientialProbeConnection(options)).rejects.toBeDefined(); expect(calls).toHaveLength(0);
  });
  it('uses entitled per-request ZDR even when account capture is enabled', async () => {
    const { options, calls } = await fixture({ capture: true });
    const c = await prepareExperientialProbeConnection(options);
    await c.fetch(url, { ...post(), body: JSON.stringify({ ...JSON.parse(post().body), provider: { zdr: false, order: ['unsafe'] } }) });
    expect(JSON.parse(calls.find(call => call.init.method === 'POST')!.init.body as string).provider).toEqual({ zdr: true });
  });
  it.each([
    { entitled: false }, { entitled: null }, { policy: { require_no_training: false } },
    { policy: { require_no_training: undefined } }, { policy: { zdr_continuation_storage: true } },
    { policy: { zdr_continuation_storage: undefined } },
  ])('fails closed on missing or unsafe privacy policy %j', async change => {
    const { options, calls } = await fixture(change);
    await expect(prepareExperientialProbeConnection(options)).rejects.toMatchObject({ code: 'privacy_preflight_failed' });
    expect(calls.every(call => call.init.method === 'GET')).toBe(true);
  });
  it.each([{}, { zdr_on_request: false }, { zdr: 'true' }])('requires verified model ZDR capability %j', async modelPolicy => {
    const { options, calls } = await fixture({ modelPolicy });
    await expect(prepareExperientialProbeConnection(options)).rejects.toMatchObject({ code: 'model_has_no_verified_zdr_route' });
    expect(calls.every(call => call.init.method === 'GET')).toBe(true);
  });
  it.each([null, 'false', 'True', '1'])('rejects unconfirmed ZDR verdict %s before reading content and never replays', async verdict => {
    const { options, calls } = await fixture({ verdict });
    const original = options.transport;
    let cancelled = false;
    let reads = 0;
    options.transport = async (url, init) => {
      const response = await original(url, init);
      if (init.method !== 'POST') return response;
      return new Response(new ReadableStream({ pull() { reads++; }, cancel() { cancelled = true; } }, { highWaterMark: 0 }), { headers: response.headers });
    };
    const c = await prepareExperientialProbeConnection(options);
    await expect(c.fetch(url, post())).rejects.toMatchObject({ code: 'zdr_response_not_confirmed_no_retry' });
    expect(cancelled).toBe(true); expect(reads).toBe(0);
    await expect(c.fetch(url, post())).rejects.toMatchObject({ code: 'probe_replay_forbidden' });
    expect(calls.filter(call => call.init.method === 'POST')).toHaveLength(1);
  });
  it.each([
    { identity_id: null }, { identity_id: provisioner }, { customer_plan_identity_id: null },
    { customer_plan_identity_id: provisioner }, { is_provisioning: true }, { is_provisioning: undefined }, { org_id: provisioner },
  ])('fails closed when key identity proof differs %j', async who => {
    const { options, calls } = await fixture({ who });
    await expect(prepareExperientialProbeConnection(options)).rejects.toMatchObject({ code: 'identity_bound_customer_key_required' });
    expect(calls.every(call => call.init.method === 'GET')).toBe(true);
  });
  it.each([
    { plan_key: 'business-max' }, { plan_version: 2 }, { revision: 2 }, { plan_key: null, plan_version: null },
    { org_id: canonical }, { identity_id: provisioner }, { pending_plan_key: 'basic' }, { pending_plan_version: 2 }, { pending_effective_at: '2026-10-01T00:00:00Z' },
  ])('rejects changed, absent or pending actual assignment %j', async change => {
    const { options, calls } = await fixture(); const original = options.transport;
    options.transport = async (url, init) => {
      const response = await original(url, init);
      return url.endsWith('/customer-plan') ? Response.json({ ...await response.json() as any, ...change }) : response;
    };
    await expect(prepareExperientialProbeConnection(options)).rejects.toMatchObject({ code: 'customer_plan_assignment_stale_or_pending' });
    expect(calls.every(call => call.init.method === 'GET')).toBe(true);
  });
  it('requires explicit trusted expected plan, never null for unknown', async () => {
    const { options, calls } = await fixture({ binding: { expectedPlan: undefined } });
    await expect(prepareExperientialProbeConnection(options)).rejects.toMatchObject({ code: 'expected_customer_plan_required' });
    expect(calls.every(call => call.init.method === 'GET')).toBe(true);
  });
  it('checks canonical UUID against management catalog detail, not a label', async () => {
    const { options, calls } = await fixture();
    options.mappings = [{ ...options.mappings[0], canonicalModelUuid: '00000000-0000-0000-0000-000000000005' }];
    await expect(prepareExperientialProbeConnection(options)).rejects.toMatchObject({ code: 'canonical_model_mapping_mismatch' });
    expect(calls.every(call => call.init.method === 'GET')).toBe(true);
  });
  it('keeps unavailable exact models unavailable', async () => {
    const { options, calls } = await fixture({ catalog: ['gpt-5.4-nano'] });
    await expect(prepareExperientialProbeConnection(options)).rejects.toMatchObject({ code: 'model_not_in_authenticated_catalog' });
    expect(calls.every(call => call.init.method === 'GET')).toBe(true);
  });
  it('preflights with management auth but dispatches exactly once with only customer auth', async () => {
    const { options, calls } = await fixture();
    const c = await prepareExperientialProbeConnection(options);
    expect(c.production_ready).toBe(false); expect(c.cutover_authorized).toBe(false); expect(c.maxRetries).toBe(0);
    await c.fetch(url, post(model, { authorization: 'Bearer caller-org-key', 'x-api-key': 'provider-secret', 'cf-aig-metadata': '{"plan":"business_ultra"}', 'x-no-capture': 'true' }));
    const posts = calls.filter(call => call.init.method === 'POST'); expect(posts).toHaveLength(1);
    expect(Object.fromEntries(new Headers(posts[0].init.headers))).toEqual({ authorization: `Bearer ${customerKey}`, 'content-type': 'application/json', accept: 'application/json' });
    expect(posts[0].init.redirect).toBe('error');
    expect(JSON.parse(posts[0].init.body as string).provider).toEqual({ zdr: true });
    await expect(c.fetch(url, post())).rejects.toMatchObject({ code: 'probe_replay_forbidden' });
    expect(calls.filter(call => call.init.method === 'POST')).toHaveLength(1);
  });
  it.each([undefined, 0, 65, -1, 1.5, '64'])('refuses unbounded synthetic output %s', async max_completion_tokens => {
    const { options, calls } = await fixture(); const c = await prepareExperientialProbeConnection(options);
    await expect(c.fetch(url, { ...post(), body: JSON.stringify({ model, max_completion_tokens, messages: [] }) })).rejects.toMatchObject({ code: 'bounded_synthetic_output_required' });
    expect(calls.filter(call => call.init.method === 'POST')).toHaveLength(0);
  });
  it('allows explicitly selected 128-token isolated probes but nothing higher', async () => {
    const { options, calls } = await fixture();
    const c = await prepareExperientialProbeConnection({ ...options, maxOutputTokens: 128 });
    await expect(c.fetch(url, { ...post(), body: JSON.stringify({ model, max_completion_tokens: 129, messages: [] }) })).rejects.toMatchObject({ code: 'bounded_synthetic_output_required' });
    await c.fetch(url, { ...post(), body: JSON.stringify({ model, max_completion_tokens: 128, messages: [] }) });
    expect(calls.filter(call => call.init.method === 'POST')).toHaveLength(1);
    const other = await fixture();
    await expect(prepareExperientialProbeConnection({ ...other.options, maxOutputTokens: 256 as any })).rejects.toMatchObject({ code: 'invalid_probe_output_bound' });
    expect(other.calls).toHaveLength(0);
  });
  it('rejects path, model and method tampering before dispatch', async () => {
    const { options, calls } = await fixture(); const c = await prepareExperientialProbeConnection(options);
    await expect(c.fetch('https://other.invalid/v1/chat/completions', post())).rejects.toMatchObject({ code: 'unexpected_probe_request' });
    await expect(c.fetch(url, post('gpt-5.4-nano'))).rejects.toMatchObject({ code: 'exact_model_mapping_required' });
    await expect(c.fetch(url, { ...post(), method: 'GET' })).rejects.toMatchObject({ code: 'unexpected_probe_request' });
    expect(calls.filter(call => call.init.method === 'POST')).toHaveLength(0);
  });
  it('requires all Astra stateless Low/Standard fields at the transport boundary', async () => {
    const { options, calls } = await fixture();
    options.sourceModelId = 'gpt-6-astra';
    options.mappings = [{ sourceModelId: 'gpt-6-astra', destinationModelId: 'gpt-6-astra', canonicalModelUuid: canonical, protocol: 'responses' }];
    const original = options.transport;
    options.transport = async (url, init) => {
      if (url.endsWith('/v1/models')) return Response.json({ data: [{ id: 'gpt-6-astra', data_policy: { zdr_on_request: true } }] });
      if (url.endsWith('/api/models/gpt-6-astra')) return Response.json({ model: { id: canonical, slug: 'gpt-6-astra' } });
      return original(url, init);
    };
    const c = await prepareExperientialProbeConnection(options);
    const valid = { model: 'gpt-6-astra', max_output_tokens: 64, input: [], reasoning: { effort: 'low' }, service_tier: 'default', store: false };
    for (const change of [{ store: true }, { previous_response_id: 'resp_previous' }, { reasoning: { effort: 'high' } }, { service_tier: 'priority' }]) {
      await expect(c.fetch(`${EXPERIENTIAL_ORIGIN}/v1/responses`, { method: 'POST', body: JSON.stringify({ ...valid, ...change }) })).rejects.toMatchObject({ code: 'astra_stateless_low_standard_required' });
    }
    expect(calls.filter(call => call.init.method === 'POST')).toHaveLength(0);
  });
  it('redacts a disconnect and refuses replay after an uncertain dispatch', async () => {
    const { options, calls } = await fixture(); const original = options.transport;
    options.transport = async (url, init) => {
      if (init.method === 'POST') { calls.push({ url, init }); throw new Error(`upstream disconnected ${customerKey}`); }
      return original(url, init);
    };
    const c = await prepareExperientialProbeConnection(options);
    await expect(c.fetch(url, post())).rejects.toMatchObject({ code: 'transport_failed_no_retry', message: 'transport_failed_no_retry' });
    await expect(c.fetch(url, post())).rejects.toMatchObject({ code: 'probe_replay_forbidden' });
    expect(calls.filter(call => call.init.method === 'POST')).toHaveLength(1);
  });
  it('rejects an off-origin success response even from an injected transport', async () => {
    const { options } = await fixture(); const original = options.transport;
    options.transport = async (url, init) => {
      const response = await original(url, init);
      if (init.method === 'POST') Object.defineProperty(response, 'url', { value: 'https://other.invalid/completion' });
      return response;
    };
    const c = await prepareExperientialProbeConnection(options);
    await expect(c.fetch(url, post())).rejects.toMatchObject({ code: 'unexpected_response_origin' });
    await expect(c.fetch(url, post())).rejects.toMatchObject({ code: 'probe_replay_forbidden' });
  });
  it.each([401, 403, 429, 500])('never retries HTTP %s or exposes upstream content', async status => {
    const { options, calls } = await fixture({ status }); const c = await prepareExperientialProbeConnection(options);
    await expect(c.fetch(url, post())).rejects.toMatchObject({ code: 'request_rejected_no_retry', status });
    await expect(c.fetch(url, post())).rejects.toMatchObject({ code: 'probe_replay_forbidden' });
    expect(calls.filter(call => call.init.method === 'POST')).toHaveLength(1);
  });
});
