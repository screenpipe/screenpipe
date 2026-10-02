// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com

// INACTIVE by default, outside the Worker import graph. This single-request
// adapter is only for an isolated harness with an injected transport. It is not
// a production selector, provisioning client, or substitute for native limits.
import type { AccountPlan, AuthResult } from '../../src/types';
import { hostedChatActorId } from '../../src/services/cloudflare-ai-gateway';
import { isHostedAiModelAllowed } from '../../src/services/hosted-ai-policy';
import { EXPERIENTIAL_ORIGIN, MigrationCheckError, inspectExperientialAccount, verifyExperientialCustomerKey, verifyExperientialCanonicalModel, isExperientialIdentityId, verifyExperientialCustomerPlan, type Fetcher } from './experiential-migration';

export interface ExperientialCustomerBinding {
  actorId: string;
  orgId: string;
  customerIdentityId: string;
  provisioningIdentityId: string;
  accountPlan: AccountPlan;
  expectedPlan: { plan_key: string; plan_version: number; revision: number };
  // Server registry only. Never accept this record from client JSON or headers.
  customerKey: string;
}
export interface ExperientialModelMapping {
  sourceModelId: string;
  destinationModelId: string;
  canonicalModelUuid: string;
  protocol: 'chat' | 'messages' | 'responses';
}
export interface ExperientialAdapterOptions {
  mode?: 'inactive' | 'isolated-test';
  // Explicit operator-selected probe bound, never a customer request override.
  maxOutputTokens?: 64 | 128;
  auth: AuthResult;
  sourceModelId: string;
  mappings: readonly ExperientialModelMapping[];
  // Read-only management preflight requires its own authorized credential.
  // It is never sent to inference or exposed in returned SDK options.
  managementKey: string;
  // Must be a trusted server-owned registry populated by authoritative Clerk /
  // website entitlement synchronization, separately from customer inference.
  lookupBinding: (actorId: string) => Promise<ExperientialCustomerBinding | null>;
  transport: Fetcher;
}
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const KEY = /^xpl_[0-9a-f]{40}$/;

/** Return native SDK connection options only after local and read-only gates.
 * The caller supplies the existing provider implementation; all normalization,
 * tools, images, and Responses -> Chat conversion stay in those providers. */
export async function prepareExperientialProbeConnection(options: ExperientialAdapterOptions) {
  if (options.mode !== 'isolated-test') throw new MigrationCheckError('experiential_adapter_inactive');
  const maxOutputTokens = options.maxOutputTokens ?? 64;
  if (maxOutputTokens !== 64 && maxOutputTokens !== 128) throw new MigrationCheckError('invalid_probe_output_bound');
  const { auth, sourceModelId } = options;
  if (auth.isValid !== true || auth.service === true || !auth.userId?.trim() || auth.accountPlan === 'unknown') {
    throw new MigrationCheckError('verified_customer_entitlement_required');
  }
  if (!isHostedAiModelAllowed(sourceModelId, auth.accountPlan)) throw new MigrationCheckError('model_not_allowed_for_source_plan');
  // Auto must be resolved first. GLM, encrypted EHBP, Vertex, audio, classifier
  // and rescue remain on existing paths even if someone supplies a mapping.
  if (!/^(gpt-|claude-)/.test(sourceModelId)) throw new MigrationCheckError('separate_route_not_migrated');
  const matches = options.mappings.filter(mapping => mapping.sourceModelId === sourceModelId);
  if (matches.length !== 1) throw new MigrationCheckError('exact_model_mapping_required');
  const mapping = { ...matches[0] };
  // Do not guess equivalent or replacement models. Any differing catalog slug
  // needs independently verified mapping support in a later reviewed change.
  if (mapping.destinationModelId !== sourceModelId || !UUID.test(mapping.canonicalModelUuid)) {
    throw new MigrationCheckError('exact_model_mapping_required');
  }
  const protocol = sourceModelId === 'gpt-6-astra' ? 'responses' : sourceModelId.startsWith('claude-') ? 'messages' : 'chat';
  if (mapping.protocol !== protocol) throw new MigrationCheckError('native_protocol_mapping_mismatch');
  const actorId = await hostedChatActorId(auth);
  const found = await options.lookupBinding(actorId);
  if (!found) throw new MigrationCheckError('customer_binding_missing');
  const binding = { ...found };
  if (binding.actorId !== actorId || binding.accountPlan !== auth.accountPlan ||
      !UUID.test(binding.orgId) || !isExperientialIdentityId(binding.customerIdentityId) || !isExperientialIdentityId(binding.provisioningIdentityId) ||
      binding.customerIdentityId === binding.provisioningIdentityId || !KEY.test(binding.customerKey)) {
    throw new MigrationCheckError('customer_binding_invalid_or_stale');
  }
  if (binding.customerKey === options.managementKey || !KEY.test(options.managementKey)) {
    throw new MigrationCheckError('separate_management_credential_required');
  }
  const preflight = await inspectExperientialAccount(options.managementKey, [mapping.destinationModelId], options.transport);
  if (preflight.org_id !== binding.orgId) throw new MigrationCheckError('customer_organization_mismatch');
  if (!preflight.checks.upstream_no_training || !preflight.checks.zdr_request_entitled ||
      !preflight.checks.zdr_continuation_storage_disabled) {
    throw new MigrationCheckError('privacy_preflight_failed');
  }
  if (!preflight.models[0]?.exact_catalog_match) throw new MigrationCheckError('model_not_in_authenticated_catalog');
  if (!preflight.models[0].zdr_route_available) throw new MigrationCheckError('model_has_no_verified_zdr_route');
  await verifyExperientialCanonicalModel(options.managementKey, mapping.destinationModelId, mapping.canonicalModelUuid, options.transport);
  await verifyExperientialCustomerKey(binding.customerKey, binding.orgId, binding.customerIdentityId, mapping.destinationModelId, options.transport);
  await verifyExperientialCustomerPlan(binding.customerKey, binding.orgId, binding.customerIdentityId, binding.expectedPlan, options.transport);
  const path = protocol === 'messages' ? '/v1/messages' : protocol === 'responses' ? '/v1/responses' : '/v1/chat/completions';
  let posted = false;
  const transport = options.transport;
  const sdkFetch = async (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
    // Validate every dispatch, including SDK/provider compatibility retries.
    if (String(url) !== `${EXPERIENTIAL_ORIGIN}${path}` || init?.method?.toUpperCase() !== 'POST' || typeof init.body !== 'string') {
      throw new MigrationCheckError('unexpected_probe_request');
    }
    let body: Record<string, any>;
    try { body = JSON.parse(init.body); } catch { throw new MigrationCheckError('invalid_probe_body'); }
    if (!body || body.model !== mapping.destinationModelId) throw new MigrationCheckError('exact_model_mapping_required');
    const outputLimit = protocol === 'responses' ? body.max_output_tokens : protocol === 'messages' ? body.max_tokens : body.max_completion_tokens ?? body.max_tokens;
    if (!Number.isInteger(outputLimit) || outputLimit < 1 || outputLimit > maxOutputTokens) {
      throw new MigrationCheckError('bounded_synthetic_output_required');
    }
    if (protocol === 'responses' && (body.store !== false || body.previous_response_id !== undefined ||
        body.reasoning?.effort !== 'low' || body.service_tier !== 'default')) {
      throw new MigrationCheckError('astra_stateless_low_standard_required');
    }
    // This harness never permits retention, including for users who opted in.
    // Replace caller provider preferences so they cannot weaken routing policy.
    body.provider = { zdr: true };
    if (posted) throw new MigrationCheckError('probe_replay_forbidden');
    posted = true;
    // Construct auth from the registry, not forwarded headers. Do not leak CF
    // credentials/metadata, org-default auth, or caller-supplied policy labels.
    const incoming = new Headers(init.headers);
    const headers = new Headers({ Authorization: `Bearer ${binding.customerKey}`, 'Content-Type': 'application/json', Accept: 'application/json' });
    if (protocol === 'messages') {
      headers.set('anthropic-version', incoming.get('anthropic-version') ?? '2023-06-01');
      const beta = incoming.get('anthropic-beta');
      if (beta) headers.set('anthropic-beta', beta);
    }
    let response: Response;
    try {
      response = await transport(String(url), { method: 'POST', headers, body: JSON.stringify(body), redirect: 'error',
        signal: init.signal ? AbortSignal.any([init.signal, AbortSignal.timeout(30_000)]) : AbortSignal.timeout(30_000) });
    } catch { throw new MigrationCheckError('transport_failed_no_retry'); }
    if (response.url && new URL(response.url).origin !== EXPERIENTIAL_ORIGIN) {
      await response.body?.cancel(); throw new MigrationCheckError('unexpected_response_origin');
    }
    if (!response.ok) {
      await response.body?.cancel();
      throw new MigrationCheckError('request_rejected_no_retry', response.status);
    }
    // Check before the SDK can consume JSON or any SSE event. Never retry a
    // missing/false verdict: dispatch may already have incurred usage.
    if (response.headers.get('x-gateway-zdr') !== 'true') {
      await response.body?.cancel();
      throw new MigrationCheckError('zdr_response_not_confirmed_no_retry');
    }
    return response;
  };
  return {
    apiKey: binding.customerKey,
    baseURL: protocol === 'messages' ? EXPERIENTIAL_ORIGIN : `${EXPERIENTIAL_ORIGIN}/v1`,
    maxRetries: 0,
    defaultHeaders: { Authorization: `Bearer ${binding.customerKey}`, ...(protocol === 'messages' ? { 'x-api-key': null } : {}) },
    fetch: sdkFetch,
    production_ready: false as const,
    cutover_authorized: false as const,
  };
}
