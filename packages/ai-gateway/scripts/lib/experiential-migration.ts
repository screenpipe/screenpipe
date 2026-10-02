// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com

import type { ResponseCreateParamsNonStreaming } from 'openai/resources/responses/responses';
import { getHostedAiAllowedModels } from '../../src/services/hosted-ai-policy';

// Deliberately outside the Worker import graph. These tools prepare and test a
// destination account; they do not select a production route or assign a plan.
export const EXPERIENTIAL_ORIGIN = 'https://api.experientiallabs.ai';
export type Fetcher = (url: string, init: RequestInit) => Promise<Response>;
type Json = Record<string, any>;
export type ProbeProtocol = 'chat' | 'stream' | 'tools' | 'json-schema' | 'responses' | 'messages';
const KEY = /^xpl_[0-9a-f]{40}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
// Gateway identities are artifact IDs, not UUIDs. Org/model IDs remain UUIDs.
export function isExperientialIdentityId(value: string): boolean {
  return value.length <= 128 && /^[a-z][a-z0-9]*([._-][a-z0-9]+)*$/.test(value);
}

export class MigrationCheckError extends Error {
  constructor(public readonly code: string, public readonly status?: number) {
    // Never include upstream error bodies, request headers, or credential values.
    super(status === undefined ? code : `${code} (HTTP ${status})`);
    this.name = 'MigrationCheckError';
  }
}

async function request(key: string, path: string, fetcher: Fetcher, body?: Json): Promise<Response> {
  if (!KEY.test(key)) throw new MigrationCheckError('invalid_credential_format');
  const response = await fetcher(`${EXPERIENTIAL_ORIGIN}${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    redirect: 'error',
    signal: AbortSignal.timeout(30_000),
    headers: { Authorization: `Bearer ${key}`, Accept: 'application/json',
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }).catch(() => { throw new MigrationCheckError('transport_failed_no_retry'); });
  if (!response.ok) {
    await response.body?.cancel();
    throw new MigrationCheckError('request_rejected_no_retry', response.status);
  }
  // Defense in depth for injected transports as well as native redirect:error.
  if (response.url && new URL(response.url).origin !== EXPERIENTIAL_ORIGIN) {
    await response.body?.cancel();
    throw new MigrationCheckError('unexpected_response_origin');
  }
  return response;
}

async function read(key: string, path: string, fetcher: Fetcher): Promise<Json> {
  const response = await request(key, path, fetcher);
  try { return await response.json() as Json; }
  catch { throw new MigrationCheckError('invalid_json_response'); }
}

export async function inspectExperientialAccount(key: string, sourceModels: string[], fetcher: Fetcher = fetch) {
  const who = await read(key, '/api/whoami', fetcher);
  if (typeof who.org_id !== 'string' || !UUID.test(who.org_id)) {
    throw new MigrationCheckError('invalid_organization_response');
  }
  // Read only. No key creation, customer export, card, inference, or settings writes.
  const [catalog, telemetry, providers] = await Promise.all([
    read(key, '/v1/models', fetcher),
    read(key, `/api/orgs/${who.org_id}/telemetry-settings`, fetcher),
    read(key, `/api/orgs/${who.org_id}/provider-policy`, fetcher),
  ]);
  if (!Array.isArray(catalog.data) || catalog.data.some((m: any) => typeof m?.id !== 'string')) {
    throw new MigrationCheckError('invalid_catalog_response');
  }
  const models = new Map<string, Json>(catalog.data.map((m: Json) => [m.id, m]));
  return {
    org_id: who.org_id as string,
    checks: {
      prompt_capture_disabled: telemetry.capture_prompt_content === false,
      upstream_no_training: providers.policy?.require_no_training === true,
      upstream_zero_retention: providers.policy?.require_zdr === true,
      // Existing require_zdr is grandfathered even without a current Pro entitlement.
      zdr_request_entitled: providers.zdr_entitled === true || providers.policy?.require_zdr === true,
      zdr_continuation_storage_disabled: providers.policy?.zdr_continuation_storage === false,
    },
    models: [...new Set(sourceModels)].map((id) => ({ id, exact_catalog_match: models.has(id),
      zdr_route_available: models.get(id)?.data_policy?.zdr === true || models.get(id)?.data_policy?.zdr_on_request === true,
    })),
    // These need live operator/provider evidence; a catalog read cannot pass them.
    unverified: [
      'native_customer_plan_enforcement', 'per_customer_identity_and_key_isolation',
      'shared_total_and_frontier_caps', 'reset_window_and_usage_carry_in',
      'settled_and_pending_usage_reconciliation', 'protocol_and_price_parity',
      'billing_activation', 'live_cloudflare_rules_and_deployed_baseline',
      'live_per_request_zdr_enforcement', 'server_owned_customer_consent_and_revocation',
    ],
    production_ready: false as const,
    cutover_authorized: false as const,
  };
}

export async function verifyExperientialCanonicalModel(managementKey: string, model: string, canonicalUuid: string, fetcher: Fetcher) {
  if (!UUID.test(canonicalUuid) || !/^(gpt-|claude-)[a-z0-9.-]+$/.test(model)) throw new MigrationCheckError('exact_model_mapping_required');
  const detail = await read(managementKey, `/api/models/${encodeURIComponent(model)}`, fetcher);
  if (detail.model?.id !== canonicalUuid || detail.model?.slug !== model) {
    throw new MigrationCheckError('canonical_model_mapping_mismatch');
  }
}

// Requires the identity-proof extension to /api/whoami. Older deployments fail
// closed instead of treating organization membership as customer isolation.
export async function verifyExperientialCustomerKey(key: string, orgId: string, identityId: string, model: string, fetcher: Fetcher) {
  if (!UUID.test(orgId) || !isExperientialIdentityId(identityId)) throw new MigrationCheckError('invalid_customer_identity');
  const who = await read(key, '/api/whoami', fetcher);
  if (who.org_id !== orgId || who.identity_id !== identityId || who.customer_plan_identity_id !== identityId || who.is_provisioning !== false) {
    throw new MigrationCheckError('identity_bound_customer_key_required');
  }
  const catalog = await read(key, '/v1/models', fetcher);
  if (!Array.isArray(catalog.data) || !catalog.data.some((entry: Json) => entry?.id === model)) {
    throw new MigrationCheckError('model_not_in_authenticated_catalog');
  }
}

export async function verifyExperientialCustomerPlan(key: string, orgId: string, identityId: string,
  expected: { plan_key: string; plan_version: number; revision: number }, fetcher: Fetcher) {
  if (!UUID.test(orgId) || !isExperientialIdentityId(identityId) ||
      !expected || !/^[a-z][a-z0-9_-]{0,63}$/.test(expected.plan_key) ||
      !Number.isSafeInteger(expected.plan_version) || expected.plan_version < 1 ||
      !Number.isSafeInteger(expected.revision) || expected.revision < 1) {
    throw new MigrationCheckError('expected_customer_plan_required');
  }
  const assignment = await read(key, `/api/orgs/${orgId}/identities/${encodeURIComponent(identityId)}/customer-plan`, fetcher);
  if (assignment.org_id !== orgId || assignment.identity_id !== identityId ||
      assignment.plan_key !== expected.plan_key || assignment.plan_version !== expected.plan_version || assignment.revision !== expected.revision ||
      assignment.pending_plan_key !== null || assignment.pending_plan_version !== null || assignment.pending_effective_at !== null) {
    throw new MigrationCheckError('customer_plan_assignment_stale_or_pending');
  }
}

const PROMPT = 'Reply with OK.';
// OpenAI's wire value for Standard service is "default", not "standard".
const STATELESS_RESPONSES_OPTIONS = { service_tier: 'default', store: false } satisfies
  Pick<ResponseCreateParamsNonStreaming, 'service_tier' | 'store'>;
const tool = { type: 'function', function: { name: 'confirm', description: 'Return confirmation.',
  parameters: { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'], additionalProperties: false } } };

export function syntheticRequest(model: string, protocol: ProbeProtocol): { path: string; body: Json } {
  // Every probe requires ZDR. Screenpipe sharing consent does not authorize
  // vendor retention, and this tool deliberately has no privacy opt-out.
  const provider = { zdr: true };
  // Excludes aliases, auto, confidential/custom, audio and background rescue routes.
  if (!getHostedAiAllowedModels('business').includes(model) || !/^(gpt-|claude-)/.test(model)) {
    throw new MigrationCheckError('unsupported_probe_model');
  }
  if (model === 'gpt-6-astra' && protocol !== 'responses') throw new MigrationCheckError('astra_requires_responses');
  if (protocol === 'messages') {
    if (!model.startsWith('claude-')) throw new MigrationCheckError('messages_requires_claude');
    return { path: '/v1/messages', body: { model, provider, max_tokens: 64, messages: [{ role: 'user', content: PROMPT }] } };
  }
  if (protocol === 'responses') {
    if (model !== 'gpt-6-astra') throw new MigrationCheckError('responses_probe_requires_astra');
    return { path: '/v1/responses', body: { model, provider, input: [{ role: 'user', content: PROMPT }],
      max_output_tokens: 64, reasoning: { effort: 'low' }, ...STATELESS_RESPONSES_OPTIONS } };
  }
  if (!['chat', 'stream', 'tools', 'json-schema'].includes(protocol)) throw new MigrationCheckError('unsupported_protocol');
  const body: Json = { model, provider, messages: [{ role: 'user', content: PROMPT }], max_completion_tokens: 64 };
  if (protocol === 'stream') Object.assign(body, { stream: true, stream_options: { include_usage: true } });
  if (protocol === 'tools') Object.assign(body, { tools: [tool], tool_choice: { type: 'function', function: { name: 'confirm' } } });
  if (protocol === 'json-schema') body.response_format = { type: 'json_schema', json_schema: {
    name: 'confirmation', strict: true, schema: tool.function.parameters,
  } };
  return { path: '/v1/chat/completions', body };
}

function validateCompletion(data: Json, protocol: ProbeProtocol): void {
  if (data.error) throw new MigrationCheckError('upstream_error_in_success_body');
  if (protocol === 'responses') {
    if (data.status !== 'completed' || !Array.isArray(data.output) || !data.output.some((item: Json) =>
      item?.type === 'message' && item.role === 'assistant' && item.status === 'completed' &&
      Array.isArray(item.content) && item.content.some((part: Json) =>
        part?.type === 'output_text' && typeof part.text === 'string' && part.text.trim()))) {
      throw new MigrationCheckError('responses_not_completed');
    }
  } else if (protocol === 'messages') {
    if (data.stop_reason !== 'end_turn' || !Array.isArray(data.content) || !data.content.some((part: Json) =>
      part?.type === 'text' && typeof part.text === 'string' && part.text.trim())) {
      throw new MigrationCheckError('messages_not_completed');
    }
  } else {
    const choice = data.choices?.[0];
    if (protocol !== 'tools' && choice?.finish_reason !== 'stop') throw new MigrationCheckError('chat_not_completed');
    if (protocol === 'tools') {
      const call = choice?.message?.tool_calls?.[0];
      if (choice?.finish_reason !== 'tool_calls' || call?.function?.name !== 'confirm') throw new MigrationCheckError('tool_call_missing');
      try { if (JSON.parse(call.function.arguments)?.ok !== true) throw new Error(); }
      catch { throw new MigrationCheckError('tool_arguments_invalid'); }
    } else if (protocol === 'json-schema') {
      try { const value = JSON.parse(choice.message?.content); if (value?.ok !== true || Object.keys(value).length !== 1) throw new Error(); }
      catch { throw new MigrationCheckError('structured_output_invalid'); }
    } else if (typeof choice.message?.content !== 'string' || !choice.message.content.trim()) {
      throw new MigrationCheckError('chat_content_missing');
    }
  }
}

async function readStream(response: Response): Promise<Json> {
  if (!response.headers.get('content-type')?.includes('text/event-stream')) throw new MigrationCheckError('expected_event_stream');
  if (!response.body) throw new MigrationCheckError('stream_body_missing');
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let pending = '', size = 0, done = false, finished = false, content = false;
  let usage: Json | undefined;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > 1_048_576) throw new MigrationCheckError('probe_response_too_large');
      pending += decoder.decode(chunk.value, { stream: true });
      let end: number;
      while ((end = pending.indexOf('\n')) >= 0) {
        const line = pending.slice(0, end).replace(/\r$/, ''); pending = pending.slice(end + 1);
        if (!line.startsWith('data:')) continue;
        const value = line.slice(5).trim();
        if (!value) continue;
        if (value === '[DONE]') { done = true; continue; }
        if (done) throw new MigrationCheckError('data_after_stream_done');
        let data: Json;
        try { data = JSON.parse(value); } catch { throw new MigrationCheckError('invalid_stream_json'); }
        if (data.error) throw new MigrationCheckError('stream_error');
        if (data.usage) usage = data.usage;
        const choice = data.choices?.[0];
        if (choice?.finish_reason === 'stop') finished = true;
        if (typeof choice?.delta?.content === 'string' && choice.delta.content.length > 0) content = true;
      }
    }
    if (!done || !finished || !content) throw new MigrationCheckError('incomplete_stream_no_retry');
    return { usage };
  } finally { await reader.cancel().catch(() => {}); }
}

export async function runSyntheticProbe(options: {
  key: string; model: string; protocol: ProbeProtocol; allowSpend: boolean;
}, fetcher: Fetcher = fetch) {
  if (options.allowSpend !== true) throw new MigrationCheckError('explicit_spend_authorization_required');
  const spec = syntheticRequest(options.model, options.protocol);
  const before = await inspectExperientialAccount(options.key, [options.model], fetcher);
  // Documented per-request ZDR suppresses capture even when the org switch is
  // on. No-training remains separate; continuation storage must stay disabled.
  if (!before.checks.upstream_no_training || !before.checks.zdr_request_entitled ||
      !before.checks.zdr_continuation_storage_disabled) throw new MigrationCheckError('privacy_preflight_failed');
  if (!before.models[0]?.exact_catalog_match) throw new MigrationCheckError('model_not_in_authenticated_catalog');
  if (!before.models[0].zdr_route_available) throw new MigrationCheckError('model_has_no_verified_zdr_route');
  // Exactly one synthetic POST. No retries, provider fallback, customer data,
  // previous_response_id, BYOK upload or production configuration changes.
  const response = await request(options.key, spec.path, fetcher, spec.body);
  // Confirm before consuming JSON or SSE. A missing/false/ambiguous verdict
  // cannot prove compliance, and must never trigger a retry without provider.zdr.
  if (response.headers.get('x-gateway-zdr') !== 'true') {
    await response.body?.cancel().catch(() => {});
    throw new MigrationCheckError('zdr_response_not_confirmed_no_retry');
  }
  let data: Json;
  try { data = options.protocol === 'stream' ? await readStream(response) : await response.json() as Json; }
  catch (error) { if (error instanceof MigrationCheckError) throw error; throw new MigrationCheckError('invalid_probe_response_no_retry'); }
  if (options.protocol !== 'stream') validateCompletion(data, options.protocol);
  const usage = data.usage;
  if (!usage || typeof usage !== 'object') throw new MigrationCheckError('usage_missing_no_retry');
  const input = usage.input_tokens ?? usage.prompt_tokens;
  const output = usage.output_tokens ?? usage.completion_tokens;
  if (!Number.isInteger(input) || input < 0 || !Number.isInteger(output) || output < 0) throw new MigrationCheckError('usage_invalid');
  const requestId = response.headers.get('x-request-id');
  return { protocol: options.protocol, model: options.model, request_id: requestId,
    zdr_requested: true, zdr_response_confirmed: true,
    input_tokens: input, output_tokens: output,
    // Optional inline cost is not authoritative settlement or allowance proof.
    inline_cost_usd: typeof usage.cost === 'number' && Number.isFinite(usage.cost) && usage.cost >= 0 ? usage.cost : null,
    settlement_verified: false, native_policy_verified: false, production_ready: false,
  };
}
