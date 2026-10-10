// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com
import { wrapRequestHandler, captureException } from '@sentry/cloudflare';
import { scrubSentryEvent } from '../../index';
import { handleSemanticTriggers } from '../../handlers/semantic-triggers';
import type { Env } from '../../types';
export { RateLimiter } from '../../index';
export default {
	fetch(request: Request, env: Env, ctx: ExecutionContext) {
		return wrapRequestHandler(
			{ options: { dsn: env.SENTRY_DSN, tracesSampleRate: 0, sendDefaultPii: false, beforeSend: scrubSentryEvent }, request, context: ctx },
			async () => {
				if (request.headers.get('Authorization') !== 'Bearer screenpipe-local-e2e-service-token')
					return Response.json({ error: 'unauthorized' }, { status: 401 });
				try {
					return await handleSemanticTriggers(
						await request.json(),
						{ ...env, JEV_API_KEY: 'test-jev-key' },
						{
							isValid: true,
							tier: 'subscribed',
							accountPlan: 'business',
							deviceId: request.headers.get('X-Device-Id') || 'fixture',
							userId: request.headers.get('X-Test-Account') || 'account-one',
						},
					);
				} catch (error) {
					captureException(error);
					return Response.json({ error: 'internal_error' }, { status: 500 });
				}
			},
		);
	},
};
