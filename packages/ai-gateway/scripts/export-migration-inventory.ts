// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com

// Offline preparation only. Imports source policy, never reads environment
// variables, credentials, customers or deployed settings, and makes no requests.
// Run from packages/ai-gateway: bun scripts/export-migration-inventory.ts
import { getHostedAiAllowedModels, getHostedAiIncludedCredits } from '../src/services/hosted-ai-policy';
import { gatewayProviderForModel } from '../src/services/cloudflare-ai-gateway';
import { isFrontierModel } from '../src/services/cost-tracker';
import type { AccountPlan } from '../src/types';

const plans: AccountPlan[] = ['free', 'basic', 'business', 'business_max', 'business_ultra', 'team', 'enterprise', 'unknown'];
const source = Bun.spawnSync(['git', 'rev-parse', 'HEAD'], { cwd: import.meta.dir });
if (source.exitCode !== 0) throw new Error('Cannot identify source revision');
const modelIds = [...new Set(plans.flatMap((plan) => [...getHostedAiAllowedModels(plan)]))];

console.log(JSON.stringify({
  schema_version: 1,
  evidence: 'repository source only; not a production or destination configuration',
  source_revision: source.stdout.toString().trim(),
  generated_at: new Date().toISOString(),
  plans: plans.map((plan) => ({
    plan,
    allowed_models: getHostedAiAllowedModels(plan),
    source_advertised_credits: getHostedAiIncludedCredits(plan),
    live_allowance: null,
  })),
  models: modelIds.map((id) => ({
    source_model_id: id,
    frontier: isFrontierModel(id),
    cloudflare_provider: gatewayProviderForModel(id),
    routing_note: id === 'auto' ? 'Resolved by Screenpipe router before provider selection'
      : id === 'screenpipe-event-classifier' ? 'Separate self-hosted route'
      : 'Hosted chat path only; separate encrypted and direct routes also exist',
    experiential_model_slug: null,
    experiential_canonical_model_uuid: null,
  })),
  unresolved: [
    'Live Cloudflare rule values, windows, enabled state and current usage',
    'Deployed Worker policy versus source revision',
    'Destination catalog, plan enforcement activation and per-customer identity mapping',
    'Equivalent shared-total plus frontier sub-limit enforcement',
    'Current-period usage and in-flight liability transfer, including rollback',
    'Provider authentication, privacy and live protocol parity',
  ],
  cutover_authorized: false,
}, null, 2));
