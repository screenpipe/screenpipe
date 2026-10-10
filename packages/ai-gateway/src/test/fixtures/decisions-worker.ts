// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com

import worker from '../../index';
import type { Env } from '../../types';
export { RateLimiter } from '../../index';

// Test-only binding adapter: the harness records and controls this outbound call.
export default {
	fetch(request: Request, env: Env, ctx: ExecutionContext) {
		const AI = { async run(model: string, body: unknown) {
			const response = await fetch('https://clef.fixture/run', {
				method: 'POST', body: JSON.stringify({ model, body }),
			});
			const result = await response.json() as any;
			if (!response.ok) throw new Error(`${result.code}: ${result.message}`);
			return result;
		} } as unknown as Ai;
		return worker.fetch(request, { ...env, AI }, ctx);
	},
};
