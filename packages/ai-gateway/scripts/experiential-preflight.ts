// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com

import { getHostedAiAllowedModels } from '../src/services/hosted-ai-policy';
import { inspectExperientialAccount, MigrationCheckError } from './lib/experiential-migration';

try {
  const report = await inspectExperientialAccount(process.env.EXPLABS_API_KEY ?? '', [
    ...getHostedAiAllowedModels('basic'), ...getHostedAiAllowedModels('business'),
  ]);
  console.log(JSON.stringify(report, null, 2));
  // Deliberately nonzero until migration gates are proven. This is not a deploy gate override.
  process.exitCode = 2;
} catch (error) {
  console.error(error instanceof MigrationCheckError ? error.message : 'Preflight failed; no changes made');
  process.exitCode = 1;
}
