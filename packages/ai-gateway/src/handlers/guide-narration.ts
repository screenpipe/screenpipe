// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com
import type { AuthResult, Env } from '../types';
import { buildHostedChatGatewayContext, getHostedChatGatewayConnection } from '../services/cloudflare-ai-gateway';
import { getHostedAiPlan } from '../services/hosted-ai-policy';
import { reserveDailyCostCap, withDailyCostSettlement } from '../services/cost-cap';
import { getCostReservationMicroUsd, logCost } from '../services/cost-tracker';
import { logReservedCost, reservedCostAttribution, settleProviderException } from '../services/hosted-ai-cost-settlement';
import { addCorsHeaders } from '../utils/cors';

const MODEL = 'eleven_multilingual_v2';
const error = (status: number, message: string) => addCorsHeaders(Response.json({ error: message }, { status }));

/** One reviewed scene, using account auth and the existing atomic cost ledger. */
export async function handleGuideNarration(request: Request, env: Env, auth: AuthResult): Promise<Response> {
	if (getHostedAiPlan(auth.accountPlan) !== 'business') return error(403, 'Guide narration requires Business.');
	const rate = Number(env.ELEVENLABS_USD_PER_CHARACTER);
	const voice = env.ELEVENLABS_VOICE_ID || '';
	if (env.GUIDE_NARRATION_ENABLED !== 'true' || !(rate > 0 && Number.isFinite(rate)) || !/^[a-zA-Z0-9]{10,64}$/.test(voice)) {
		return error(503, 'Guide narration is not available yet. Your guide is saved.');
	}
	// Bound both chunked and Content-Length requests before JSON parsing.
	const reader = request.body?.getReader();
	if (!reader) return error(400, 'Add narration text.');
	let body = '';
	let bytes = 0;
	const decoder = new TextDecoder();
	while (true) {
		const part = await reader.read();
		if (part.done) break;
		bytes += part.value.byteLength;
		if (bytes > 8192) {
			await reader.cancel();
			return error(413, 'Use a shorter scene.');
		}
		body += decoder.decode(part.value, { stream: true });
	}
	body += decoder.decode();
	let text: unknown;
	try {
		text = JSON.parse(body).text;
	} catch {
		return error(400, 'Invalid narration request.');
	}
	if (typeof text !== 'string' || !text.trim() || [...text].length > 800) return error(400, 'Each scene needs 1–800 characters.');
	const cost = [...text].length * rate;
	// Reuse the conservative unpriced-model hold. Never admit speech above it.
	// Exact character cost is settled below; no fabricated token counts.
	if (cost * 1_000_000 > getCostReservationMicroUsd(MODEL)) return error(413, 'Split this narration into shorter scenes.');
	const context = await buildHostedChatGatewayContext(auth, MODEL, 'interactive');
	const connection = await getHostedChatGatewayConnection(env, 'elevenlabs', context);
	const hold = await reserveDailyCostCap(
		env,
		auth.deviceId,
		auth.tier,
		MODEL,
		new Date(),
		'interactive',
		{},
		auth.accountPlan,
		auth.hostedAiTrial === true,
	);
	if (!hold.allowed) return hold.response;
	const attribution = reservedCostAttribution(auth, MODEL, '/v1/guide-narration', false, { provider: 'elevenlabs' });
	const abort = new AbortController();
	const cancel = () => abort.abort();
	request.signal.addEventListener('abort', cancel, { once: true });
	if (request.signal.aborted) cancel();
	const timer = setTimeout(cancel, 60000);
	try {
		const headers = new Headers({ 'Content-Type': 'application/json' });
		for (const [key, value] of Object.entries(connection.defaultHeaders)) if (value !== null) headers.set(key, value);
		headers.set('cf-aig-skip-cache', 'true');
		const upstream = await fetch(`${connection.baseURL.replace(/\/$/, '')}/v1/text-to-speech/${voice}?output_format=mp3_44100_128`, {
			method: 'POST',
			headers,
			body: JSON.stringify({ text, model_id: MODEL }),
			signal: abort.signal,
			redirect: 'manual',
		});
		if (!upstream.ok || !upstream.headers.get('content-type')?.startsWith('audio/')) {
			await upstream.body?.cancel();
			return withDailyCostSettlement(
				error(
					upstream.status === 429 ? 429 : 502,
					upstream.status === 429
						? 'Narration allowance reached. Try again later.'
						: 'Narration could not be generated. Your guide is saved.',
				),
				env,
				hold.reservation,
				logReservedCost(env, hold.reservation, attribution),
			);
		}
		const response = addCorsHeaders(
			// Keep the request timeout active until the audio body is complete.
			new Response(await upstream.arrayBuffer(), { headers: { 'Content-Type': 'audio/mpeg', 'Cache-Control': 'no-store' } }),
		);
		return withDailyCostSettlement(
			response,
			env,
			hold.reservation,
			logCost(env, {
				device_id: auth.deviceId,
				user_id: auth.userId,
				tier: auth.tier,
				hosted_ai_trial: auth.hostedAiTrial === true,
				endpoint: '/v1/guide-narration',
				stream: false,
				provider: 'elevenlabs',
				model: MODEL,
				input_tokens: null,
				output_tokens: null,
				estimated_cost_usd: cost,
				settlement_id: hold.reservation?.key,
				lane: hold.reservation?.lane,
				cost_ledger_epoch: hold.reservation?.ledgerEpoch,
				cost_total_ledger_epoch: hold.reservation?.totalLedgerEpoch,
			}),
		);
	} catch {
		await settleProviderException(env, hold.reservation, attribution);
		return error(502, 'Narration was interrupted. Your guide is saved.');
	} finally {
		clearTimeout(timer);
		request.signal.removeEventListener('abort', cancel);
	}
}
