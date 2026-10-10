// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com

import type { AuthResult, Env } from '../types';
import { addCorsHeaders } from '../utils/cors';
import { isBackgroundRequest } from '../utils/latency';
import { reserveDailyCostCap, withDailyCostSettlement } from '../services/cost-cap';
import { getModelCost, logCost } from '../services/cost-tracker';
import { reservedCostAttribution, settleProviderException } from '../services/hosted-ai-cost-settlement';
import { logApiRouteAudit } from '../services/api-audit';

export const DECISION_MAX_REQUEST_BYTES = 13 * 1024 * 1024;
type JsonObject = Record<string, unknown>;
const object = (value: unknown): value is JsonObject =>
	value !== null && typeof value === 'object' && !Array.isArray(value);
const content = (value: unknown): boolean =>
	(typeof value === 'string' && value.trim().length > 0) || object(value) || Array.isArray(value);

// Keep the provider's native typed-question contract; never adapt decisions to chat.
export function validateDecisionRequest(value: unknown): string | null {
	if (!object(value)) return 'Expected a JSON object.';
	if (value.model !== 'clef' && value.model !== 'clef-flash') return 'model must be clef or clef-flash.';
	if (!content(value.state)) return 'state must be non-empty text, an object, or an array.';
	if (!object(value.questions)) return 'questions must be an object.';
	const entries = Object.entries(value.questions);
	if (entries.length < 1 || entries.length > 64) return 'Provide 1 to 64 questions.';
	for (const [id, q] of entries) {
		if (!/^[a-zA-Z0-9_.-]{1,100}$/.test(id) || !object(q) || !content(q.instructions)) return 'Invalid question id or instructions.';
		if (q.type === 'choice') {
			if (!object(q.criteria) || Object.keys(q.criteria).length < 2 || Object.keys(q.criteria).length > 255 || Object.keys(q.criteria).some((key) => !key.trim())) return 'choice requires 2 to 255 named criteria.';
		} else if (q.type === 'score') {
			if (!Array.isArray(q.criteria) || q.criteria.length < 2 || q.criteria.length > 10 || !q.criteria.every(content)) return 'score requires 2 to 10 ordered criteria.';
		} else if (q.type === 'noul') {
			if (q.criteria !== undefined && !object(q.criteria)) return 'noul criteria must be an object.';
		} else return 'Question type must be noul, choice, or score.';
	}
	if (value.images !== undefined) {
		if (!Array.isArray(value.images) || value.images.length > 4) return 'Provide at most 4 embedded images.';
		for (const image of value.images) {
			if (typeof image === 'string' && /^data:image\/(png|jpeg|webp);base64,/i.test(image)) continue;
			if (object(image) && ['image/png', 'image/jpeg', 'image/webp'].includes(String(image.content_type)) && typeof image.base64 === 'string' && image.base64.length > 0) continue;
			return 'Images must be embedded PNG, JPEG, or WebP; remote URLs are not accepted.';
		}
	}
	return null;
}

export async function handleDecisions(value: unknown, request: Request, env: Env, auth: AuthResult): Promise<Response> {
	const invalid = validateDecisionRequest(value);
	if (invalid) return addCorsHeaders(Response.json({ error: 'invalid_decision_request', message: invalid }, { status: 400 }));
	const body = value as JsonObject;
	const model = body.model as 'clef' | 'clef-flash';
	const workload = isBackgroundRequest(request) ? 'background' : 'interactive';
	// Full context ceiling also covers image tokens and the typed-question schema.
	const hold = await reserveDailyCostCap(env, auth.deviceId, auth.tier, model, new Date(), workload,
		{ inputTokens: 65_536, maxOutputTokens: 0 }, auth.accountPlan, auth.hostedAiTrial === true);
	if (!hold.allowed) return hold.response;
	const start = Date.now();
	const attribution = reservedCostAttribution(auth, model, '/v1/decisions', false, { provider: 'cloudflare' });
	let result: { model: string; answers: JsonObject; usage: { input_tokens: number; output_tokens: number } };
	let status = 200;
	try {
		// SDK model typings predate Clef. Bind this invocation locally instead of
		// broadening Env.AI or introducing a separate credential / gateway balance.
		const run = env.AI.run.bind(env.AI) as unknown as (name: string, input: JsonObject) => Promise<unknown>;
		const output = await run(`@cf/cloudflare/${model}`, {
			model, state: body.state, questions: body.questions,
			...(body.images === undefined ? {} : { images: body.images }),
		});
		if (!object(output) || output.model !== model || !object(output.answers) ||
			!Object.keys(body.questions as JsonObject).every((id) => Object.prototype.hasOwnProperty.call(output.answers, id)) ||
			!object(output.usage) || !Number.isSafeInteger(output.usage.input_tokens) || Number(output.usage.input_tokens) < 0) {
			throw Object.assign(new Error('Invalid Clef response'), { code: 'invalid_response' });
		}
		result = output as typeof result;
	} catch (error) {
		status = 500;
		await settleProviderException(env, hold.reservation, attribution);
		// Provider messages may echo screenshots or state. Preserve the bounded
		// technical code in the normal Sentry report without copying that content.
		const raw = object(error) ? error : {};
		const messageCode = typeof raw.message === 'string' ? raw.message.match(/^(?:AI_ERROR:\s*)?(\d{3,6}):/)?.[1] : undefined;
		const code = typeof raw.code === 'number' || (typeof raw.code === 'string' && /^[a-zA-Z0-9_-]{1,64}$/.test(raw.code)) ? String(raw.code) : messageCode ?? 'unknown';
		throw new Error(`Workers AI ${model} inference failed (code=${code})`);
	} finally {
		logApiRouteAudit({ requested_model: model, resolved_model: model, served_model: status === 200 ? model : 'unknown',
			workload, gateway_mode: 'direct', latency_ms: Date.now() - start, status_code: status });
	}
	const reservation = hold.reservation;
	const settlement = logCost(env, {
		settlement_id: reservation?.key, device_id: auth.deviceId, user_id: auth.userId,
		tier: auth.tier, hosted_ai_trial: auth.hostedAiTrial === true,
		provider: 'cloudflare', model, input_tokens: result.usage.input_tokens, output_tokens: 0,
		estimated_cost_usd: getModelCost(model, result.usage.input_tokens, 0),
		endpoint: '/v1/decisions', stream: false, latency_ms: Date.now() - start,
		lane: reservation?.lane, cost_ledger_epoch: reservation?.ledgerEpoch,
		cost_total_ledger_epoch: reservation?.totalLedgerEpoch,
	});
	return withDailyCostSettlement(addCorsHeaders(Response.json(result, { headers: { 'Cache-Control': 'no-store' } })), env, reservation, settlement);
}
