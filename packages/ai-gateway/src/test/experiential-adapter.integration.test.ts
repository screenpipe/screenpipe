// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com

// Opt-in actual local control API + gateway HTTP. This never seeds or changes
// plans/settings and refuses non-loopback destinations or real upstreams.
// SCREENPIPE_EXPERIENTIAL_LOCAL_FIXTURE=/private/path.json bun test this-file
import { describe, expect, it } from 'bun:test';
import { prepareExperientialProbeConnection, type ExperientialCustomerBinding } from '../../scripts/lib/experiential-adapter';
import { EXPERIENTIAL_ORIGIN, type Fetcher } from '../../scripts/lib/experiential-migration';
import { hostedChatActorId } from '../services/cloudflare-ai-gateway';
import { OpenAIProvider } from '../providers/openai';
import type { AccountPlan, AuthResult, RequestBody } from '../types';

interface LocalFixture {
  controlBaseUrl: string;
  gatewayBaseUrl: string;
  managementKey: string;
  orgId: string;
  provisioningIdentityId: string;
  canonicalModelUuid: string;
  model: string;
  syntheticUpstream: true;
  customers: Array<{ userId: string; identityId: string; customerKey: string; accountPlan: AccountPlan; expectedPlan: ExperientialCustomerBinding['expectedPlan'] }>;
}
const fixturePath = process.env.SCREENPIPE_EXPERIENTIAL_LOCAL_FIXTURE;
function loopbackBase(value: string) {
  const url = new URL(value);
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || !url.port || url.username || url.password ||
      url.pathname !== '/' || url.search || url.hash) throw new Error('local fixture must use an explicit IPv4 loopback port');
  return url.origin;
}

describe.skipIf(!fixturePath)('inactive adapter with actual isolated control API and gateway', () => {
  it('authenticates two customers independently and runs native SDK JSON and stream requests', async () => {
    const fixture = await Bun.file(fixturePath!).json() as LocalFixture;
    if (fixture.syntheticUpstream !== true || fixture.model !== 'gpt-5.4-mini' || fixture.customers.length !== 2) {
      throw new Error('requires two synthetic customers and the exact gpt-5.4-mini local fixture');
    }
    const control = loopbackBase(fixture.controlBaseUrl);
    const gateway = loopbackBase(fixture.gatewayBaseUrl);
    const dispatches: Array<{ identityId: string; path: string }> = [];
    const transport: Fetcher = async (requested, init) => {
      const source = new URL(requested);
      if (source.origin !== EXPERIENTIAL_ORIGIN || source.search || source.hash) throw new Error('unexpected local adapter origin');
      const isInference = init.method?.toUpperCase() === 'POST';
      if (isInference && source.pathname !== '/v1/chat/completions') throw new Error('unexpected local inference path');
      if (isInference) {
        const auth = new Headers(init.headers).get('authorization');
        const customer = fixture.customers.find(row => auth === `Bearer ${row.customerKey}`);
        if (!customer) throw new Error('inference did not use a registered synthetic customer');
        dispatches.push({ identityId: customer.identityId, path: source.pathname });
      }
      // Ignore proxy environment variables for this loopback-only connection.
      // Preserve actual API status/body; strip only the response URL caused by
      // the deliberate harness origin rewrite (production rejects redirects).
      const response = await fetch(`${isInference ? gateway : control}${source.pathname}`, { ...init, redirect: 'error', proxy: null } as RequestInit);
      return new Response(response.body, { status: response.status, statusText: response.statusText, headers: response.headers });
    };
    const registry = new Map<string, ExperientialCustomerBinding>();
    const auths: AuthResult[] = [];
    for (const customer of fixture.customers) {
      const auth: AuthResult = { isValid: true, tier: 'subscribed', accountPlan: customer.accountPlan, userId: customer.userId, deviceId: 'synthetic-device' };
      const actorId = await hostedChatActorId(auth);
      if (registry.has(actorId)) throw new Error('synthetic customers must have separate actors');
      registry.set(actorId, { actorId, orgId: fixture.orgId, provisioningIdentityId: fixture.provisioningIdentityId,
        customerIdentityId: customer.identityId, accountPlan: customer.accountPlan, expectedPlan: customer.expectedPlan, customerKey: customer.customerKey });
      auths.push(auth);
    }
    expect(fixture.customers[0].identityId === fixture.customers[1].identityId).toBe(false);
    expect(fixture.customers[0].customerKey === fixture.customers[1].customerKey).toBe(false);
    for (let index = 0; index < auths.length; index++) {
      const connection = await prepareExperientialProbeConnection({ mode: 'isolated-test', auth: auths[index],
        sourceModelId: fixture.model, managementKey: fixture.managementKey, transport,
        mappings: [{ sourceModelId: fixture.model, destinationModelId: fixture.model, canonicalModelUuid: fixture.canonicalModelUuid, protocol: 'chat' }],
        lookupBinding: async actorId => registry.get(actorId) ?? null,
      });
      const provider = new OpenAIProvider(connection.apiKey, connection.baseURL, connection.defaultHeaders, connection.maxRetries);
      (provider as any).client.fetch = connection.fetch;
      const body: RequestBody = { model: fixture.model, max_completion_tokens: 64, messages: [{ role: 'user', content: 'Synthetic fixture: reply OK.' }] };
      if (index === 0) {
        const response: any = await (await provider.createCompletion(body)).json();
        expect(response.choices?.[0]?.finish_reason).toBe('stop');
        expect(typeof response.choices?.[0]?.message?.content).toBe('string');
        expect(response.choices[0].message.content.length).toBeGreaterThan(0);
        expect(response.usage?.prompt_tokens).toBeGreaterThanOrEqual(0);
      } else {
        const text = await new Response(await provider.createStreamingCompletion(body)).text();
        expect(text.endsWith('data: [DONE]\n\n')).toBe(true);
        const events = text.split('\n\n').filter(line => line.startsWith('data: {')).map(line => JSON.parse(line.slice(6)));
        expect(events.some(event => event.choices?.[0]?.delta?.content)).toBe(true);
        expect(events.some(event => event.choices?.[0]?.finish_reason === 'stop')).toBe(true);
        expect(events.some(event => event.usage && Number.isInteger(event.usage.prompt_tokens))).toBe(true);
      }
      expect(connection.production_ready).toBe(false);
    }
    expect(dispatches).toEqual(fixture.customers.map(customer => ({ identityId: customer.identityId, path: '/v1/chat/completions' })));
  }, 30_000);
});
