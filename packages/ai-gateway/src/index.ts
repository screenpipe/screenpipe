import { captureException, wrapRequestHandler } from '@sentry/cloudflare';
import { Env, RequestBody, AuthResult } from './types';
import { handleOptions, createSuccessResponse, createErrorResponse, addCorsHeaders } from './utils/cors';
import { validateAuth } from './utils/auth';
import { RateLimiter, checkRateLimit } from './utils/rate-limiter';
import { trackUsage, getUsageStatus, isModelAllowed, getTierConfig, getCreditBalance } from './services/usage-tracker';
import { handleChatCompletions } from './handlers/chat';
import { handleModelListing } from './handlers/models';
import { handleFileTranscription, handleABTestAdmin } from './handlers/transcription';
import { handleRealtimeTranscriptionUpgrade } from './handlers/realtime-transcription';
import { handleVoiceTranscription, handleVoiceQuery, handleTextToSpeech, handleVoiceChat } from './handlers/voice';
import { handleVertexProxy, handleVertexModels } from './handlers/vertex-proxy';
import { handleWebSearch } from './handlers/web-search';
import { handleTinfoilAttestation, handleTinfoilProxy } from './handlers/tinfoil-proxy';
import { logCost, getModelCost, inferProvider, getSpendSummary, getDailyUserCost, getMaxDailyCostPerUser, getTierDailyCostCap, isZeroCostModel } from './services/cost-tracker';
import { trackResponseUsage } from './utils/stream-usage-tracker';
import { getModelWeight } from './services/usage-tracker';
import { pruneModelHealth } from './services/model-health';
// import { handleTTSWebSocketUpgrade } from './handlers/voice-ws';

export { RateLimiter };

// Handler function for the worker
async function handleRequest(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
	const url = new URL(request.url);
	const path = url.pathname;

	// Early test endpoint - before any initialization
	if (path === '/test') {
		return new Response('ai proxy is working!', { status: 200 });
	}

	try {
		if (request.method === 'OPTIONS') {
			return handleOptions(request);
		}

		console.log('path', path);

		// Authenticate and get tier info for all other endpoints
		const authResult = await validateAuth(request, env);
		console.log('auth result:', { tier: authResult.tier, deviceId: authResult.deviceId });

		// Check rate limit with tier info
		const rateLimit = await checkRateLimit(request, env, authResult);
		if (!rateLimit.allowed && rateLimit.response) {
			return rateLimit.response;
		}

		// Usage status endpoint - returns current usage without incrementing
		if (path === '/v1/usage' && request.method === 'GET') {
			const status = await getUsageStatus(env, authResult.deviceId, authResult.tier, authResult.userId);
			// Enrich with cost-based limit flag (NOT the raw $ numbers — those
			// are our internal margin and shouldn't leak to any client/user).
			// Credits extend the cap 1:1 (1 credit = $1 of headroom) so that the
			// /billing top-up button actually lifts the limit it advertises.
			const dailyCost = await getDailyUserCost(env, authResult.deviceId);
			const maxCost = getTierDailyCostCap(authResult.tier, env);
			const credits = authResult.userId ? await getCreditBalance(env, authResult.userId) : 0;
			const enriched = {
				...status,
				cost_limit_reached: dailyCost >= maxCost + credits,
			};
			return addCorsHeaders(createSuccessResponse(enriched));
		}

		// Admin spend endpoint - aggregated AI cost data
		if (path === '/v1/admin/spend' && request.method === 'GET') {
			const authHeader = request.headers.get('Authorization');
			const token = authHeader?.replace('Bearer ', '');
			if (!env.ADMIN_SECRET || token !== env.ADMIN_SECRET) {
				return addCorsHeaders(createErrorResponse(401, 'unauthorized'));
			}
			const range = parseInt(url.searchParams.get('range') || '7', 10);
			const summary = await getSpendSummary(env, range);
			return addCorsHeaders(createSuccessResponse(summary));
		}

		// Admin A/B test results endpoint
		if (path === '/v1/admin/transcription-ab' && request.method === 'GET') {
			const authHeader = request.headers.get('Authorization');
			const token = authHeader?.replace('Bearer ', '');
			if (!env.ADMIN_SECRET || token !== env.ADMIN_SECRET) {
				return addCorsHeaders(createErrorResponse(401, 'unauthorized'));
			}
			return addCorsHeaders(await handleABTestAdmin(request, env));
		}

		// Chat completions - main AI endpoint
		if (path === '/v1/chat/completions' && request.method === 'POST') {
			let body: RequestBody;
			try {
				body = (await request.json()) as RequestBody;
			} catch {
				return addCorsHeaders(createErrorResponse(400, JSON.stringify({
					error: 'invalid_json',
					message: 'Request body must be valid JSON.',
				})));
			}

			// Check if model is allowed for this tier
			if (!isModelAllowed(body.model, authResult.tier, env)) {
				const allowedModels = getTierConfig(env)[authResult.tier].allowedModels;
				return addCorsHeaders(createErrorResponse(403, JSON.stringify({
					error: 'model_not_allowed',
					message: `Model "${body.model}" is not available for your tier (${authResult.tier}). Available models: ${allowedModels.join(', ')}`,
					tier: authResult.tier,
					allowed_models: allowedModels,
				})));
			}

			// Per-user daily cost cap — only for expensive models (weight >= 3).
			// Cheap models (weight 0-1) like qwen3.5-flash, haiku, deepseek-chat
			// should not trigger cost caps — they're affordable and pipes need them.
			// Subscribed users get 5x higher cap.
			//
			// Credits extend the cap 1:1: a user with a $50 credit balance gets
			// $50 more headroom for today before this 429 fires. Required to make
			// the /billing one-click top-up actually unblock the user it sold to.
			// (The credits are separately consumed per-query in the trackUsage
			// path below, so this is just the ceiling check.)
			const modelWeight = getModelWeight(body.model);
			if (!isZeroCostModel(body.model) && modelWeight >= 3) {
				const dailyCost = await getDailyUserCost(env, authResult.deviceId);
				const maxCost = getTierDailyCostCap(authResult.tier, env);
				const credits = authResult.userId ? await getCreditBalance(env, authResult.userId) : 0;
				if (dailyCost >= maxCost + credits) {
					const resetsAt = new Date();
					resetsAt.setUTCHours(24, 0, 0, 0);
					return addCorsHeaders(createErrorResponse(429, JSON.stringify({
						error: 'daily_cost_limit_exceeded',
						message: `You've hit today's AI usage limit. This is an account-wide budget that background pipes also consume. Switch to a free model (gemini-3-flash, qwen3.5-flash, claude-haiku-4-5) or review Settings → Pipes for chatty schedules.`,
						resets_at: resetsAt.toISOString(),
						tier: authResult.tier,
						free_models: ['gemini-3-flash', 'qwen3.5-flash', 'claude-haiku-4-5'],
					})));
				}
			}

			// Track usage and check daily limit (includes IP-based abuse prevention)
			const ipAddress = request.headers.get('cf-connecting-ip') || undefined;
			const usage = await trackUsage(env, authResult.deviceId, authResult.tier, authResult.userId, ipAddress, body.model);
			if (!usage.allowed) {
				const creditsExhausted = (usage.creditsRemaining ?? 0) <= 0;
				return addCorsHeaders(createErrorResponse(429, JSON.stringify({
					error: creditsExhausted ? 'credits_exhausted' : 'daily_limit_exceeded',
					message: creditsExhausted
						? `You've used all free queries and have no credits remaining. Buy more at screenpi.pe`
						: `You've used all ${usage.limit} free AI queries for today. Resets at ${usage.resetsAt}`,
					used_today: usage.used,
					limit_today: usage.limit,
					resets_at: usage.resetsAt,
					tier: authResult.tier,
					credits_remaining: usage.creditsRemaining ?? 0,
					upgrade_options: {
						...(authResult.tier === 'anonymous'
							? { login: { benefit: '+25 daily queries, more models' } }
							: {}),
						buy_credits: {
							url: 'https://screenpi.pe/onboarding',
							benefit: 'Credits extend your daily limit — use anytime',
						},
						subscribe: {
							url: 'https://screenpi.pe/onboarding',
							benefit: `${getTierConfig(env).subscribed.dailyQueries} queries/day + 500 credits/mo + encrypted sync`,
							price: '$29/mo',
						},
					},
				})));
			}

			// Add credit info header if paid via credits
			let response = await handleChatCompletions(body, env);

			// Log cost — for streaming, intercept SSE events to get real token counts
			if (body.stream) {
				const { response: trackedResponse, usage: usagePromise } = trackResponseUsage(response, 'openai');
				response = trackedResponse;
				ctx.waitUntil(usagePromise.then(u => logCost(env, {
					device_id: authResult.deviceId,
					user_id: authResult.userId,
					tier: authResult.tier,
					provider: inferProvider(body.model),
					model: body.model,
					input_tokens: u.input_tokens ?? null,
					output_tokens: u.output_tokens ?? null,
					estimated_cost_usd: getModelCost(body.model, u.input_tokens ?? null, u.output_tokens ?? null),
					endpoint: '/v1/chat/completions',
					stream: true,
				})));
			} else {
				ctx.waitUntil((async () => {
					try {
						const cloned = response.clone();
						const json = await cloned.json() as any;
						const inputTokens = json?.usage?.prompt_tokens ?? null;
						const outputTokens = json?.usage?.completion_tokens ?? null;
						await logCost(env, {
							device_id: authResult.deviceId,
							user_id: authResult.userId,
							tier: authResult.tier,
							provider: inferProvider(body.model),
							model: body.model,
							input_tokens: inputTokens,
							output_tokens: outputTokens,
							estimated_cost_usd: getModelCost(body.model, inputTokens, outputTokens),
							endpoint: '/v1/chat/completions',
							stream: false,
						});
					} catch (e) {
						console.error('cost log extraction failed:', e);
					}
				})());
			}

			if (usage.paidVia === 'credits' && usage.creditsRemaining !== undefined) {
				const newResponse = new Response(response.body, response);
				newResponse.headers.set('X-Credits-Remaining', String(usage.creditsRemaining));
				newResponse.headers.set('X-Paid-Via', 'credits');
				return newResponse;
			}
			return response;
		}

		// Web search endpoint - uses Gemini's Google Search grounding
		if (path === '/v1/web-search' && request.method === 'POST') {
			// Track usage (counts as 1 query, web search uses gemini flash)
			const ipAddress = request.headers.get('cf-connecting-ip') || undefined;
			const usage = await trackUsage(env, authResult.deviceId, authResult.tier, authResult.userId, ipAddress, 'gemini-2.5-flash');
			if (!usage.allowed) {
				return addCorsHeaders(createErrorResponse(429, JSON.stringify({
					error: (usage.creditsRemaining ?? 0) <= 0 ? 'credits_exhausted' : 'daily_limit_exceeded',
					message: `You've used all ${usage.limit} free queries for today. Resets at ${usage.resetsAt}`,
					used_today: usage.used,
					limit_today: usage.limit,
					resets_at: usage.resetsAt,
					tier: authResult.tier,
					credits_remaining: usage.creditsRemaining ?? 0,
				})));
			}
			const webSearchResponse = await handleWebSearch(request, env);
			ctx.waitUntil(logCost(env, {
				device_id: authResult.deviceId,
				user_id: authResult.userId,
				tier: authResult.tier,
				provider: 'google',
				model: 'gemini-2.5-flash',
				input_tokens: null,
				output_tokens: null,
				estimated_cost_usd: getModelCost('gemini-2.5-flash', null, null),
				endpoint: '/v1/web-search',
				stream: false,
			}));
			return webSearchResponse;
		}

		if (path === '/v1/listen' && request.method === 'POST') {
			// Per-user daily cost cap for transcription
			// 2x safety margin: free=$10/day, subscribed=$50/day
			const dailyCost = await getDailyUserCost(env, authResult.deviceId);
			const baseCap = getMaxDailyCostPerUser(env);
			const maxCost = authResult.tier === 'subscribed' ? baseCap * 100 : baseCap * 2;
			if (dailyCost >= maxCost) {
				return addCorsHeaders(createErrorResponse(429, JSON.stringify({
					error: 'daily_cost_limit_exceeded',
					message: `You've reached your daily transcription limit ($${maxCost}/day). Audio will be transcribed locally until tomorrow.`,
					daily_cost: dailyCost,
					limit: maxCost,
				})));
			}

			// Estimate cost from audio size: ~30s chunks at $0.26/hr = $0.0022/chunk
			// More precise: estimate duration from Content-Length (MP3 at 64kbps = 8KB/s)
			const contentLength = parseInt(request.headers.get('content-length') || '0');
			const estimatedSeconds = contentLength > 0 ? contentLength / 8000 : 30;
			const estimatedCost = (estimatedSeconds / 3600) * 0.26;

			const response = await handleFileTranscription(request, env, ctx, authResult.deviceId);

			// Log cost after successful transcription
			if (response.ok) {
				ctx.waitUntil(logCost(env, {
					device_id: authResult.deviceId,
					user_id: authResult.userId,
					tier: authResult.tier,
					provider: 'deepgram',
					model: 'nova-3',
					input_tokens: Math.round(estimatedSeconds),
					output_tokens: null,
					estimated_cost_usd: estimatedCost,
					endpoint: '/v1/listen',
					stream: false,
				}));
			}

			return response;
		}

		if (path === '/v1/realtime' && request.method === 'GET') {
			return await handleRealtimeTranscriptionUpgrade(request, env, ctx, authResult);
		}

		if (path === '/v1/models' && request.method === 'GET') {
			// Prune old health records opportunistically (fire-and-forget)
			ctx.waitUntil(pruneModelHealth(env));
			// Return tier-filtered models with live health status
			return await handleModelListing(env, authResult.tier);
		}

		// ─── Tinfoil E2EE proxy ────────────────────────────────────────
		// Distinct from the server-side `gemma4-31b` integration in
		// providers/tinfoil.ts — these routes preserve end-to-end body
		// encryption (HPKE/EHBP). The gateway never sees plaintext.
		// Spec: https://docs.tinfoil.sh/guides/proxy-server
		if (path === '/v1/tinfoil/attestation' && request.method === 'GET') {
			// Public-ish (still tier-gated above so we know who's calling) —
			// just forwards the attestation bundle which is itself public.
			return await handleTinfoilAttestation(env);
		}
		if (path === '/v1/tinfoil/chat/completions' && request.method === 'POST') {
			return await handleTinfoilProxy(request, env, authResult, '/v1/chat/completions');
		}
		if (path === '/v1/tinfoil/responses' && request.method === 'POST') {
			return await handleTinfoilProxy(request, env, authResult, '/v1/responses');
		}

		if (path === '/v1/voice/transcribe' && request.method === 'POST') {
			return await handleVoiceTranscription(request, env);
		}

		if (path === '/v1/voice/query' && request.method === 'POST') {
			return await handleVoiceQuery(request, env);
		}

		if (path === '/v1/text-to-speech' && request.method === 'POST') {
			return await handleTextToSpeech(request, env);
		}

		if (path === '/v1/voice/chat' && request.method === 'POST') {
			return await handleVoiceChat(request, env);
		}

		// //TODO:
		// if (path === '/v1/tts-ws' && upgradeHeader === 'websocket') {
		// 	return await handleTTSWebSocketUpgrade(request, env);
		// }

		// Vertex AI proxy for Agent SDK
		// The Agent SDK sends requests to ANTHROPIC_VERTEX_BASE_URL/v1/messages
		if (path === '/v1/messages' && request.method === 'POST') {
			console.log('Vertex AI proxy request to /v1/messages');

			// Require authentication for Agent SDK
			if (authResult.tier === 'anonymous') {
				return addCorsHeaders(createErrorResponse(401, JSON.stringify({
					error: 'authentication_required',
					message: 'Vertex AI proxy requires authentication. Please log in to screenpipe.',
				})));
			}

			// Check model from body (clone request so proxy can still read it)
			const clonedRequest = request.clone();
			let parsedModel = 'claude-haiku-4-5-20251001';
			let parsedStream = false;
			try {
				const body = (await clonedRequest.json()) as { model?: string; stream?: boolean };
				parsedModel = body.model || parsedModel;
				parsedStream = body.stream === true;
				if (!isModelAllowed(parsedModel, authResult.tier, env)) {
					const allowedModels = getTierConfig(env)[authResult.tier].allowedModels;
					return addCorsHeaders(createErrorResponse(403, JSON.stringify({
						error: 'model_not_allowed',
						message: `Model "${parsedModel}" is not available for your tier (${authResult.tier}). Available models: ${allowedModels.join(', ')}`,
						tier: authResult.tier,
						allowed_models: allowedModels,
					})));
				}
			} catch (e) {
				// If body parse fails, let the proxy handle the error downstream
			}

			// Per-user daily cost cap — only expensive models (weight >= 3)
			const msgModelWeight = getModelWeight(parsedModel);
			if (!isZeroCostModel(parsedModel) && msgModelWeight >= 3) {
				const dailyCost = await getDailyUserCost(env, authResult.deviceId);
				const maxCost = getTierDailyCostCap(authResult.tier, env);
				if (dailyCost >= maxCost) {
					const resetsAt = new Date();
					resetsAt.setUTCHours(24, 0, 0, 0);
					return addCorsHeaders(createErrorResponse(429, JSON.stringify({
						error: 'daily_cost_limit_exceeded',
						message: `You've hit today's AI usage limit. This is an account-wide budget that background pipes also consume. Switch to a free model (gemini-3-flash, qwen3.5-flash, claude-haiku-4-5) or review Settings → Pipes for chatty schedules.`,
						resets_at: resetsAt.toISOString(),
						tier: authResult.tier,
						free_models: ['gemini-3-flash', 'qwen3.5-flash', 'claude-haiku-4-5'],
					})));
				}
			}

			// Track usage and check daily limit (weighted by model)
			const ipAddress = request.headers.get('cf-connecting-ip') || undefined;
			const usage = await trackUsage(env, authResult.deviceId, authResult.tier, authResult.userId, ipAddress, parsedModel);
			if (!usage.allowed) {
				return addCorsHeaders(createErrorResponse(429, JSON.stringify({
					error: (usage.creditsRemaining ?? 0) <= 0 ? 'credits_exhausted' : 'daily_limit_exceeded',
					message: `You've used all ${usage.limit} AI queries for today. Resets at ${usage.resetsAt}`,
					used_today: usage.used,
					limit_today: usage.limit,
					resets_at: usage.resetsAt,
					tier: authResult.tier,
					credits_remaining: usage.creditsRemaining ?? 0,
				})));
			}

			let vertexResponse = await handleVertexProxy(request, env);
			// Log cost — intercept stream for real token counts
			if (parsedStream) {
				const { response: trackedResponse, usage: usagePromise } = trackResponseUsage(vertexResponse, 'anthropic');
				vertexResponse = trackedResponse;
				ctx.waitUntil(usagePromise.then(u => logCost(env, {
					device_id: authResult.deviceId,
					user_id: authResult.userId,
					tier: authResult.tier,
					provider: inferProvider(parsedModel),
					model: parsedModel,
					input_tokens: u.input_tokens ?? null,
					output_tokens: u.output_tokens ?? null,
					estimated_cost_usd: getModelCost(parsedModel, u.input_tokens ?? null, u.output_tokens ?? null),
					endpoint: '/v1/messages',
					stream: true,
				})));
			} else {
				ctx.waitUntil((async () => {
					try {
						const clonedResp = vertexResponse.clone();
						const json = await clonedResp.json() as any;
						const inputTokens = json?.usage?.input_tokens ?? null;
						const outputTokens = json?.usage?.output_tokens ?? null;
						await logCost(env, {
							device_id: authResult.deviceId,
							user_id: authResult.userId,
							tier: authResult.tier,
							provider: inferProvider(parsedModel),
							model: parsedModel,
							input_tokens: inputTokens,
							output_tokens: outputTokens,
							estimated_cost_usd: getModelCost(parsedModel, inputTokens, outputTokens),
							endpoint: '/v1/messages',
							stream: false,
						});
					} catch (e) {
						console.error('cost log /v1/messages failed:', e);
					}
				})());
			}
			return vertexResponse;
		}

		// Anthropic-compatible endpoint for OpenCode integration
		// OpenCode sends requests to baseURL/v1/messages when configured with api: "anthropic"
		// Requires logged-in user (not anonymous)
		if (path === '/anthropic/v1/messages' && request.method === 'POST') {
			console.log('OpenCode Anthropic proxy request to /anthropic/v1/messages');

			// Require authentication for OpenCode
			if (authResult.tier === 'anonymous') {
				return addCorsHeaders(createErrorResponse(401, JSON.stringify({
					error: 'authentication_required',
					message: 'OpenCode requires authentication. Please log in to screenpipe.',
				})));
			}

			// Extract model/stream before proxy consumes the body
			let ocModel = 'claude-haiku-4-5-20251001';
			let ocStream = false;
			try {
				const clonedReq = request.clone();
				const reqBody = await clonedReq.json() as { model?: string; stream?: boolean };
				ocModel = reqBody.model || ocModel;
				ocStream = reqBody.stream === true;
			} catch (e) {
				// body parse failure — proceed with defaults
			}

			// Per-user daily cost cap — only expensive models (weight >= 3)
			const ocModelWeight = getModelWeight(ocModel);
			if (!isZeroCostModel(ocModel) && ocModelWeight >= 3) {
				const dailyCost = await getDailyUserCost(env, authResult.deviceId);
				const maxCost = getTierDailyCostCap(authResult.tier, env);
				if (dailyCost >= maxCost) {
					const resetsAt = new Date();
					resetsAt.setUTCHours(24, 0, 0, 0);
					return addCorsHeaders(createErrorResponse(429, JSON.stringify({
						error: 'daily_cost_limit_exceeded',
						message: `You've hit today's AI usage limit. This is an account-wide budget that background pipes also consume. Switch to a free model (gemini-3-flash, qwen3.5-flash, claude-haiku-4-5) or review Settings → Pipes for chatty schedules.`,
						resets_at: resetsAt.toISOString(),
						tier: authResult.tier,
						free_models: ['gemini-3-flash', 'qwen3.5-flash', 'claude-haiku-4-5'],
					})));
				}
			}

			// Track usage for OpenCode requests (weighted by model)
			const ipAddress = request.headers.get('cf-connecting-ip') || undefined;
			const usage = await trackUsage(env, authResult.deviceId, authResult.tier, authResult.userId, ipAddress, ocModel);
			if (!usage.allowed) {
				return addCorsHeaders(createErrorResponse(429, JSON.stringify({
					error: (usage.creditsRemaining ?? 0) <= 0 ? 'credits_exhausted' : 'daily_limit_exceeded',
					message: `You've used all ${usage.limit} AI queries for today. Resets at ${usage.resetsAt}`,
					used_today: usage.used,
					limit_today: usage.limit,
					resets_at: usage.resetsAt,
					tier: authResult.tier,
					credits_remaining: usage.creditsRemaining ?? 0,
				})));
			}

			let anthropicResponse = await handleVertexProxy(request, env);
			// Log cost — intercept stream for real token counts
			if (ocStream) {
				const { response: trackedResponse, usage: usagePromise } = trackResponseUsage(anthropicResponse, 'anthropic');
				anthropicResponse = trackedResponse;
				ctx.waitUntil(usagePromise.then(u => logCost(env, {
					device_id: authResult.deviceId,
					user_id: authResult.userId,
					tier: authResult.tier,
					provider: inferProvider(ocModel),
					model: ocModel,
					input_tokens: u.input_tokens ?? null,
					output_tokens: u.output_tokens ?? null,
					estimated_cost_usd: getModelCost(ocModel, u.input_tokens ?? null, u.output_tokens ?? null),
					endpoint: '/anthropic/v1/messages',
					stream: true,
				})));
			} else {
				ctx.waitUntil((async () => {
					try {
						const clonedResp = anthropicResponse.clone();
						const json = await clonedResp.json() as any;
						const inputTokens = json?.usage?.input_tokens ?? null;
						const outputTokens = json?.usage?.output_tokens ?? null;
						await logCost(env, {
							device_id: authResult.deviceId,
							user_id: authResult.userId,
							tier: authResult.tier,
							provider: inferProvider(ocModel),
							model: ocModel,
							input_tokens: inputTokens,
							output_tokens: outputTokens,
							estimated_cost_usd: getModelCost(ocModel, inputTokens, outputTokens),
							endpoint: '/anthropic/v1/messages',
							stream: false,
						});
					} catch (e) {
						console.error('cost log /anthropic/v1/messages failed:', e);
					}
				})());
			}
			return anthropicResponse;
		}

		// Anthropic models endpoint for OpenCode
		if (path === '/anthropic/v1/models' && request.method === 'GET') {
			console.log('OpenCode Anthropic models request');
			return await handleVertexModels(env);
		}

		return createErrorResponse(404, 'not found');
	} catch (error: any) {
		console.error('error in fetch:', error?.message, error?.stack);
		captureException(error);
		return createErrorResponse(500, error?.message || 'an error occurred');
	} finally {
	}
}

// Strip PII from a Sentry event before send. The default @sentry/cloudflare
// integration attaches request headers, URL, and (for traces) query string —
// all of which regularly contain Clerk JWTs (user_id + email inside the
// token payload) and device fingerprints. Error messages can also include
// full prompts. We keep enough context to debug (method, path, status,
// model, provider tags) while redacting anything that identifies a user.
function scrubSentryEvent(event: any): any {
	const REDACTED = '[REDACTED]';
	const cap = (s: unknown, n = 512): string => {
		if (typeof s !== 'string') return typeof s === 'undefined' ? '' : String(s);
		return s.length > n ? s.slice(0, n) + '…[truncated]' : s;
	};
	const redactQs = (qs: string): string =>
		qs
			.replace(/(^|&)(id|user_id|email|token)=[^&]*/gi, '$1$2=' + REDACTED)
			.replace(/user_[A-Za-z0-9]+/g, 'user_' + REDACTED);
	const redactUrl = (url: string): string => {
		if (!url) return url;
		const [base, qs] = url.split('?');
		return qs ? `${base}?${redactQs(qs)}` : base;
	};

	try {
		if (event.request) {
			if (event.request.headers) {
				// Headers often contain Authorization: Bearer <JWT>, Cookie, X-Device-Id
				for (const k of Object.keys(event.request.headers)) {
					const lk = k.toLowerCase();
					if (
						lk === 'authorization' ||
						lk === 'cookie' ||
						lk === 'x-device-id' ||
						lk === 'x-forwarded-for' ||
						lk === 'cf-connecting-ip'
					) {
						event.request.headers[k] = REDACTED;
					}
				}
			}
			if (event.request.url) event.request.url = redactUrl(event.request.url);
			if (event.request.query_string) event.request.query_string = redactQs(event.request.query_string);
			// Request body can contain full prompt text — drop it. Error tags will
			// carry the model/provider which is what we actually need to triage.
			if (event.request.data) event.request.data = '[body redacted]';
		}
		// Truncate exception messages so a stack trace with leaked prompt text
		// doesn't fill the event — stack frames themselves stay intact.
		if (event.exception?.values) {
			for (const v of event.exception.values) {
				if (v.value) v.value = cap(v.value);
			}
		}
		if (event.message) event.message = cap(event.message);
	} catch {
		// Never let the scrubber itself throw — it would mask the real error.
	}
	return event;
}

// Wrap with Sentry for error tracking
export default {
	async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
		return wrapRequestHandler(
			{
				options: {
					dsn: env.SENTRY_DSN,
					tracesSampleRate: 0.1,
					beforeSend: scrubSentryEvent,
					// release must match the value passed to `sentry-cli sourcemaps
					// upload --release=<R>` at deploy time, otherwise Sentry can't
					// symbolicate stack frames and every event shows `index.js:NNN`
					// instead of the real provider .ts file + line number.
					release: env.SENTRY_RELEASE,
				},
				request: request as any,
				context: ctx,
			},
			() => handleRequest(request, env, ctx)
		);
	},
} satisfies ExportedHandler<Env>;

/*
terminal 1

cd packages/ai-gateway
wrangler dev


terminal 2
HOST=https://api.screenpi.pe
HOST=http://localhost:8787
TOKEN=foobar (check app settings)
in
less "$HOME/Library/Application Support/screenpipe/store.bin"


curl $HOST/test


curl -X POST $HOST/v1/listen \
  -H "Content-Type: audio/wav" \
  -H "detect_language: en" \
  -H "Authorization: Bearer $TOKEN" \
  --data-binary "@./crates/screenpipe-audio/test_data/poetic_kapil_gupta.wav"

# Test free tier (no auth)
curl -X POST $HOST/v1/chat/completions \
-H "Content-Type: application/json" \
-H "X-Device-Id: test-device-123" \
-d '{
"model": "claude-haiku-4-5-20251001",
"messages": [
	{
	"role": "user",
	"content": "Tell me a short joke."
	}
],
"stream": true
}' | while read -r line; do
echo "$line" | sed 's/^data: //g' | jq -r '.choices[0].delta.content // empty' 2>/dev/null
done | tr -d '\n'

# Check usage
curl "$HOST/v1/usage" -H "X-Device-Id: test-device-123"

curl -X POST $HOST/v1/chat/completions \
-H "Content-Type: application/json" \
-H "Authorization: Bearer $TOKEN" \
-d '{
"model": "gpt-5.4",
"messages": [
	{
	"role": "system",
	"content": "You are a helpful assistant."
	},
	{
	"role": "user",
	"content": "Tell me a short joke."
	}
],
"stream": true
}' | while read -r line; do
echo "$line" | sed 's/^data: //g' | jq -r '.choices[0].delta.content // empty' 2>/dev/null
done | tr -d '\n'

using anthropic

curl -X POST $HOST/v1/chat/completions \
-H "Content-Type: application/json" \
-H "Authorization: Bearer $TOKEN" \
-d '{
"model": "claude-3-5-sonnet-20240620",
"messages": [
	{
	"role": "system",
	"content": "You are a helpful assistant."
	},
	{
	"role": "user",
	"content": "Tell me a short joke."
	}
],
"stream": true
}' | while read -r line; do
echo "$line" | sed 's/^data: //g' | jq -r '.choices[0].delta.content // empty' 2>/dev/null
done | tr -d '\n'

using gemini

curl -X POST $HOST/v1/chat/completions \
-H "Content-Type: application/json" \
-H "Authorization: Bearer $TOKEN" \
-d '{
"model": "gemini-1.5-flash-latest",
"stream": true,
"messages": [
    {
        "role": "system",
        "content": "You are a helpful assistant."
    },
    {
        "role": "user",
        "content": "Tell me a short joke."
    }
]
}'

deployment

wrangler deploy

rate limit testing

# test openai endpoint (should hit limit faster)
for i in {1..25}; do
  echo "Request $i"
  curl -X POST "$HOST/v1/chat/completions" \
    -H "Content-Type: application/json" \
    -d '{"model":"gpt-4","messages":[{"role":"user","content":"hi"}]}' \
    -w "\nStatus: %{http_code}\n"
  sleep 0.1
done

*/
