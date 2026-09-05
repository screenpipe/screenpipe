// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com

import type { RequestBody, ToolCall } from '../types';
import { OpenAIProvider } from './openai';

export const SCREENPIPE_GLM_MODEL = 'glm-5.3-flash-reap50-iq3m';
const DIRECT_GLM_BASE_URL = 'https://pii.screenpipe.containers.tinfoil.dev/glm/v1';
const GLM_CORE_SKILLS = new Set([
	'render-html-report',
	'screenpipe-api',
	'screenpipe-chats',
	'screenpipe-cli',
	'screenpipe-team',
]);
const GLM_COMPACTED_MIN_OUTPUT_TOKENS = 4096;
const GLM_MAX_TOOL_RESULT_CHARS = 8000;
const GLM_TOOL_RESULT_COMPACTION_MARKER = '\n...[tool result compacted for GLM 32K context; reread a narrower range if needed]...\n';

type GlmTool = {
	type?: string;
	function?: {
		name?: string;
		parameters?: { properties?: Record<string, { type?: string }> };
	};
};

function parseGlmArgument(value: string, type?: string): unknown {
	if (type === 'string') return value;
	try {
		return JSON.parse(value);
	} catch {
		return value;
	}
}

/**
 * The pinned llama.cpp GLM runtime currently exposes the model's native
 * `<tool_call>` payload as assistant content instead of OpenAI `tool_calls`.
 * Convert only a leading, schema-known call so arbitrary model/user text can
 * never become an executable Pi action.
 */
export function parseGlmToolCallContent(content: unknown, tools: unknown): ToolCall[] {
	if (typeof content !== 'string' || !Array.isArray(tools)) return [];
	const trimmed = content.trim();

	const knownTools = new Map<string, GlmTool>();
	for (const tool of tools as GlmTool[]) {
		const name = tool?.type === 'function' ? tool.function?.name : undefined;
		if (name) knownTools.set(name, tool);
	}
	const makeToolCall = (name: string, args: Record<string, unknown>): ToolCall => ({
		id: `call_glm_${crypto.randomUUID().replaceAll('-', '').slice(0, 24)}`,
		type: 'function',
		function: { name, arguments: JSON.stringify(args) },
	});

	// Some GLM generations omit the documented XML wrapper but still return an
	// exact JSON function-call object. Accept only the complete known-tool shape.
	if (trimmed.startsWith('{')) {
		try {
			const parsed = JSON.parse(trimmed);
			const name = parsed?.function?.name ?? parsed?.name;
			let args = parsed?.function?.arguments ?? parsed?.arguments;
			if (typeof args === 'string') args = JSON.parse(args);
			if (typeof name !== 'string' || !knownTools.has(name)) return [];
			if (!args || Array.isArray(args) || typeof args !== 'object') return [];
			return [makeToolCall(name, args)];
		} catch {
			return [];
		}
	}
	if (!trimmed.startsWith('<tool_call>')) return [];

	const calls: ToolCall[] = [];
	const callPattern = /<tool_call>\s*([A-Za-z0-9_.:-]+)([\s\S]*?)(?=<tool_call>|$)/g;
	for (const match of trimmed.matchAll(callPattern)) {
		const name = match[1];
		const tool = knownTools.get(name);
		if (!tool) return [];

		const body = match[2].replace(/<\/tool_call>\s*$/, '').trim();
		const properties = tool.function?.parameters?.properties ?? {};
		const args: Record<string, unknown> = {};
		const taggedPattern = /<arg_key>([\s\S]*?)<\/arg_key>\s*<arg_value>([\s\S]*?)<\/arg_value>/g;
		let taggedMatch: RegExpExecArray | null;
		let taggedCount = 0;
		while ((taggedMatch = taggedPattern.exec(body)) !== null) {
			const key = taggedMatch[1].trim();
			if (!key) return [];
			args[key] = parseGlmArgument(taggedMatch[2], properties[key]?.type);
			taggedCount++;
		}

		if (taggedCount === 0) {
			let jsonBody = body;
			if (jsonBody.startsWith('"')) jsonBody = `{${jsonBody}}`;
			try {
				const parsed = JSON.parse(jsonBody);
				if (!parsed || Array.isArray(parsed) || typeof parsed !== 'object') return [];
				Object.assign(args, parsed);
			} catch {
				return [];
			}
		}

		calls.push(makeToolCall(name, args));
	}

	return calls;
}

function sseEvent(data: unknown): Uint8Array {
	return new TextEncoder().encode(`data: ${JSON.stringify(data)}\n\n`);
}

function normalizeGlmToolCallStream(stream: ReadableStream, tools: unknown[]): ReadableStream {
	const reader = stream.getReader();
	const decoder = new TextDecoder();
	type Mode = 'undecided' | 'passthrough' | 'tool' | 'parsed';
	let mode: Mode = 'undecided';
	let pending: string[] = [];
	let content = '';
	let inputBuffer = '';

	return new ReadableStream({
		async start(controller) {
			const emit = (raw: string) => controller.enqueue(new TextEncoder().encode(raw));
			const flushPending = () => {
				for (const raw of pending) emit(raw);
				pending = [];
			};
			const handleEvent = (raw: string) => {
				const line = raw.trim();
				if (!line.startsWith('data: ')) {
					if (mode === 'passthrough' || mode === 'parsed') emit(raw);
					else pending.push(raw);
					return;
				}
				if (line === 'data: [DONE]') {
					if (mode === 'tool') {
						const calls = parseGlmToolCallContent(content, tools);
						if (calls.length > 0) {
							controller.enqueue(sseEvent({
								choices: [{ delta: { tool_calls: calls.map((call, index) => ({ index, ...call })) } }],
							}));
							controller.enqueue(sseEvent({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] }));
							mode = 'parsed';
							pending = [];
						} else {
							mode = 'passthrough';
							flushPending();
						}
					}
					emit(raw);
					return;
				}

				let event: any;
				try {
					event = JSON.parse(line.slice('data: '.length));
				} catch {
					if (mode === 'passthrough' || mode === 'parsed') emit(raw);
					else pending.push(raw);
					return;
				}

				if (mode === 'passthrough' || mode === 'parsed') {
					emit(raw);
					return;
				}

				const choice = event.choices?.[0];
				const deltaContent = choice?.delta?.content;
				if (Array.isArray(choice?.delta?.tool_calls)) {
					mode = 'passthrough';
					flushPending();
					emit(raw);
					return;
				}
				// Reasoning arrives before GLM's final content. It cannot be a
				// native tool-call payload, so forward it immediately while the
				// content-only detector remains undecided. Buffering these chunks
				// made long-thinking requests look completely frozen in Pi.
				const hasReasoning = ['reasoning_content', 'reasoning', 'reasoning_text']
					.some((field) => typeof choice?.delta?.[field] === 'string' && choice.delta[field].length > 0);
				if (hasReasoning && typeof deltaContent !== 'string') {
					emit(raw);
					return;
				}

				pending.push(raw);
				if (typeof deltaContent === 'string') {
					content += deltaContent;
					if (mode === 'tool') return;
					const candidate = content.trimStart();
					if (candidate === '' || '<tool_call>'.startsWith(candidate) || candidate === '{') return;
					if (candidate.startsWith('<tool_call>') || candidate.startsWith('{')) {
						mode = 'tool';
						return;
					}
					mode = 'passthrough';
					flushPending();
					return;
				}

				if (choice?.finish_reason) {
					if (mode === 'tool') {
						const calls = parseGlmToolCallContent(content, tools);
						if (calls.length > 0) {
							controller.enqueue(sseEvent({
								choices: [{ delta: { tool_calls: calls.map((call, index) => ({ index, ...call })) } }],
							}));
							controller.enqueue(sseEvent({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] }));
							mode = 'parsed';
							pending = [];
							return;
						}
					}
					mode = 'passthrough';
					flushPending();
				}
			};

			try {
				while (true) {
					const { done, value } = await reader.read();
					if (done) break;
					inputBuffer += decoder.decode(value, { stream: true });
					let boundary: number;
					while ((boundary = inputBuffer.indexOf('\n\n')) >= 0) {
						const raw = inputBuffer.slice(0, boundary + 2);
						inputBuffer = inputBuffer.slice(boundary + 2);
						handleEvent(raw);
					}
				}
				inputBuffer += decoder.decode();
				if (inputBuffer) handleEvent(inputBuffer);
				if (mode !== 'passthrough' && mode !== 'parsed') flushPending();
				controller.close();
			} catch (error) {
				controller.error(error);
			}
		},
		cancel() {
			return reader.cancel();
		},
	});
}

function compactGlmSkillCatalog(content: string): string {
	return content.replace(
		/<available_skills>([\s\S]*?)<\/available_skills>/g,
		(fullCatalog, entries: string) => {
			const skillBlocks = entries.match(/\s*<skill>[\s\S]*?<\/skill>/g);
			if (!skillBlocks) return fullCatalog;
			const retained = skillBlocks.filter((block) => {
				const name = block.match(/<name>\s*([^<]+?)\s*<\/name>/)?.[1];
				return name ? GLM_CORE_SKILLS.has(name) : false;
			});
			return `<available_skills>${retained.join('')}\n</available_skills>`;
		},
	);
}

function hasGlmSkillCatalog(content: string): boolean {
	return /<available_skills>[\s\S]*?<\/available_skills>/.test(content);
}

function isGlmCatalogMessage(message: RequestBody['messages'][number]): boolean {
	if (message.role !== 'system' && message.role !== 'developer') return false;
	if (typeof message.content === 'string') return hasGlmSkillCatalog(message.content);
	return message.content.some((part) =>
		part.type === 'text' && typeof part.text === 'string' && hasGlmSkillCatalog(part.text)
	);
}

function compactGlmToolResultText(content: string): string {
	if (content.length <= GLM_MAX_TOOL_RESULT_CHARS) return content;
	const available = GLM_MAX_TOOL_RESULT_CHARS - GLM_TOOL_RESULT_COMPACTION_MARKER.length;
	const headChars = Math.ceil(available * 0.82);
	const tailChars = available - headChars;
	return `${content.slice(0, headChars)}${GLM_TOOL_RESULT_COMPACTION_MARKER}${content.slice(-tailChars)}`;
}

function compactGlmToolResultMessage(message: RequestBody['messages'][number]): RequestBody['messages'][number] {
	if (message.role !== 'tool' || typeof message.content !== 'string') return message;
	return { ...message, content: compactGlmToolResultText(message.content) };
}

function compactGlmSystemMessage(message: RequestBody['messages'][number]): RequestBody['messages'][number] {
	if (message.role !== 'system' && message.role !== 'developer') return message;
	if (typeof message.content === 'string') {
		return { ...message, content: compactGlmSkillCatalog(message.content) };
	}
	return {
		...message,
		content: message.content.map((part) =>
			part.type === 'text' && typeof part.text === 'string'
				? { ...part, text: compactGlmSkillCatalog(part.text) }
				: part,
		),
	};
}

function isSubagentTool(tool: unknown): boolean {
	if (!tool || typeof tool !== 'object') return false;
	const candidate = tool as { type?: unknown; function?: { name?: unknown } };
	return candidate.type === 'function' && candidate.function?.name === 'subagent';
}

/**
 * Pi's normal prompt advertises every installed skill and the full subagent
 * orchestration schema. That baseline alone is about 31K tokens on Louis's
 * real Screenpipe profile, leaving a 32K model one token for its answer.
 *
 * Keep the core Screenpipe skills and ordinary tools, but omit capabilities
 * that this single-slot model cannot fit. The files remain local and richer
 * models keep the complete catalog; this changes only what GLM sees.
 */
export function normalizeGlmRequest(body: RequestBody): RequestBody {
	const compactsPiContext = body.messages.some(isGlmCatalogMessage)
		|| (Array.isArray(body.tools) && body.tools.some(isSubagentTool));
	const normalized: RequestBody = {
		...body,
		model: SCREENPIPE_GLM_MODEL,
		messages: body.messages
			.map(compactGlmSystemMessage)
			.map((message) => compactsPiContext ? compactGlmToolResultMessage(message) : message),
		tools: Array.isArray(body.tools) ? body.tools.filter((tool) => !isSubagentTool(tool)) : body.tools,
	};

	// Pi clamps the output limit against its pre-gateway prompt estimate. With a
	// large installed skill catalog that becomes one token even though the
	// gateway removes most of that catalog before inference. Restore a useful
	// answer budget only for requests where this GLM-specific compaction ran;
	// ordinary API clients that intentionally request a tiny answer are unchanged.
	if (compactsPiContext) {
		if (normalized.max_completion_tokens !== undefined) {
			normalized.max_completion_tokens = Math.max(
				normalized.max_completion_tokens,
				GLM_COMPACTED_MIN_OUTPUT_TOKENS,
			);
		}
		if (normalized.max_tokens !== undefined) {
			normalized.max_tokens = Math.max(normalized.max_tokens, GLM_COMPACTED_MIN_OUTPUT_TOKENS);
		}
	}

	return normalized;
}

/**
 * Text-only GLM served beside the privacy filter in Screenpipe's Tinfoil CVM.
 * Requests may go directly to the enclave or through Cloudflare AI Gateway's
 * `custom-tinfoil` provider; both paths use the container-owned bearer secret.
 */
export class ScreenpipeGlmProvider extends OpenAIProvider {
	supportsTools = true;
	supportsVision = false;

	constructor(
		apiKey: string,
		baseURL = DIRECT_GLM_BASE_URL,
		defaultHeaders?: Record<string, string | null | undefined>,
		maxRetries = 0,
	) {
		super(apiKey, baseURL, defaultHeaders, maxRetries);
	}

	protected getChatTemplateKwargs(body: RequestBody): Record<string, unknown> {
		// The deployed GLM template has binary thinking, not graded effort.
		// Pi defaults interactive chats to "medium" and its 32K Day Recap
		// prompt already consumes most of that window. Treat medium and below
		// as the fast/non-thinking path; high+ remains an explicit opt-in.
		return {
			enable_thinking: body.reasoning_effort === 'high'
				|| body.reasoning_effort === 'xhigh'
				|| String(body.reasoning_effort) === 'max',
		};
	}

	async createCompletion(body: RequestBody): Promise<Response> {
		const response = await super.createCompletion(normalizeGlmRequest(body));
		if (!Array.isArray(body.tools) || body.tools.length === 0) return response;
		const payload: any = await response.json();
		const message = payload.choices?.[0]?.message;
		if (Array.isArray(message?.tool_calls) && message.tool_calls.length > 0) {
			return new Response(JSON.stringify(payload), response);
		}
		const toolCalls = parseGlmToolCallContent(message?.content, body.tools);
		if (toolCalls.length > 0) {
			message.content = null;
			message.tool_calls = toolCalls;
			payload.choices[0].finish_reason = 'tool_calls';
		}
		return new Response(JSON.stringify(payload), response);
	}

	async createStreamingCompletion(body: RequestBody): Promise<ReadableStream> {
		const stream = await super.createStreamingCompletion(normalizeGlmRequest(body));
		if (!Array.isArray(body.tools) || body.tools.length === 0) return stream;
		return normalizeGlmToolCallStream(stream, body.tools);
	}
}

export function isScreenpipeGlmModel(model: string): boolean {
	return model.toLowerCase() === SCREENPIPE_GLM_MODEL;
}
