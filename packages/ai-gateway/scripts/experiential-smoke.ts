// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com

import { MigrationCheckError, runSyntheticProbe, type ProbeProtocol } from './lib/experiential-migration';

const args = process.argv.slice(2);
if (args.length !== 3 || args[0] !== '--allow-spend') {
  console.error('Usage: bun scripts/experiential-smoke.ts --allow-spend <exact-model-id> <chat|stream|tools|json-schema|responses|messages>');
  console.error('One synthetic inference request, at most 64 output tokens. Requires explicit spending approval and a configured test key in EXPLABS_API_KEY.');
  process.exitCode = 1;
} else {
  try {
    console.log(JSON.stringify(await runSyntheticProbe({ key: process.env.EXPLABS_API_KEY ?? '',
      model: args[1], protocol: args[2] as ProbeProtocol, allowSpend: true }), null, 2));
  } catch (error) {
    console.error(error instanceof MigrationCheckError ? error.message : 'Probe failed; outcome may be uncertain. Do not retry automatically.');
    process.exitCode = 1;
  }
}
