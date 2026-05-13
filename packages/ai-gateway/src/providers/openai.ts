import { AIProvider } from './base';
import { Message, RequestBody, ResponseFormat } from '../types';
import OpenAI from 'openai';
import type { ChatCompletionMessage, ChatCompletionCreateParams } from 'openai/resources/chat';
import type { ResponseFormatJSONSchema } from 'openai/resources';
import { captureException } from '@sentry/cloudflare';

export class OpenAIProvider implements AIProvider {
	supportsTools = true;
	supportsVision = true;
	supportsJson = true;
	private client: OpenAI;

	constructor(apiKey: string, baseURL?: string) {
		this.client = new OpenAI({ apiKey, ...(baseURL ? { baseURL } : {}) });
	}

	private createJSONSchemaFormat(schema: Record<string, unknown>, name: string, description?: string): ResponseFormatJSONSchema {
		return {
			type: 'json_schema',
			json_schema: {
				name,
				description,
				schema,
				strict: true,
			},
		};
	}

	private formatResponseFormat(format?: ResponseFormat): ChatCompletionCreateParams['response_format'] {
		if (!format) return undefined;

		switch (format.type) {
			case 'json_object':
				return { type: 'json_object' };
			case 'json_schema':
				if (!format.schema || !format.name) {
					throw new Error('Schema and name are required for json_schema response format');
				}
				return this.createJSONSchemaFormat(format.schema, format.name, format.description);
			default:
				return undefined;
		}
	}

	private usesMaxCompletionTokens(model: string): boolean {
		const lower = model.toLowerCase();
		return lower.startsWith('gpt-5') || lower.startsWith('o1') || lower.startsWith('o3') || lower.startsWith('o4');
	}

	private applyTokenLimit(params: ChatCompletionCreateParams, body: RequestBody): void {
		const maxTokens = body.max_completion_tokens ?? body.max_tokens;
		if (maxTokens === undefined) return;

		if (this.usesMaxCompletionTokens(body.model) || body.max_completion_tokens !== undefined) {
			(params as ChatCompletionCreateParams & { max_completion_tokens?: number }).max_completion_tokens = maxTokens;
			return;
		}
		(params as ChatCompletionCreateParams & { max_tokens?: number }).max_tokens = maxTokens;
	}

	async createCompletion(body: RequestBody): Promise<Response> {
		const messages = this.formatMessages(body.messages);
		const responseFormat = this.formatResponseFormat(body.response_format);

		const params: ChatCompletionCreateParams = {
			model: body.model,
			messages,
			temperature: body.temperature,
			stream: false,
			response_format: responseFormat,
			tools: body.tools as ChatCompletionCreateParams['tools'],
			tool_choice: body.tool_choice as ChatCompletionCreateParams['tool_choice'],
		};

		this.applyTokenLimit(params, body);

		const response = await this.client.chat.completions.create(params);
		return new Response(JSON.stringify(this.formatResponse(response)), {
			headers: { 'Content-Type': 'application/json' },
		});
	}

	async createStreamingCompletion(body: RequestBody): Promise<ReadableStream> {
		const params: ChatCompletionCreateParams = {
			model: body.model,
			messages: this.formatMessages(body.messages),
			temperature: body.temperature,
			stream: true,
			response_format: this.formatResponseFormat(body.response_format),
			tools: body.tools as ChatCompletionCreateParams['tools'],
		};

		this.applyTokenLimit(params, body);

		const stream = await this.client.chat.completions.create(params);

		// Capture scope fields for the error path below — `this` inside the
		// ReadableStream start() refers to the controller, not the provider.
		const modelForTags = body.model;
		const baseURLForTags = this.client.baseURL || 'openai-default';

		return new ReadableStream({
			async start(controller) {
				try {
					for await (const chunk of stream) {
						if (body.response_format?.type === 'json_object' || body.response_format?.type === 'json_schema') {
							const content = chunk.choices[0]?.delta?.content;
							if (content) {
								controller.enqueue(
									new TextEncoder().encode(
										`data: ${JSON.stringify({
											choices: [{ delta: { content } }],
										})}\n\n`
									)
								);
							}
						} else {
							const content = chunk.choices[0]?.delta?.content;
							if (content) {
								controller.enqueue(
									new TextEncoder().encode(
										`data: ${JSON.stringify({
											choices: [{ delta: { content } }],
										})}\n\n`
									)
								);
							}
						}
					}
	
					controller.enqueue(new TextEncoder().encode('data: [DONE]\n\n'));
					controller.close();
				} catch (error: any) {
					console.error('Streaming error:', error);
					// Record the error in Sentry with model/provider tags. This
					// path is normally swallowed into an SSE `data: {error:…}`
					// event, so without this the client sees "random error"
					// and we have no server-side trace. Tags let you filter
					// by model (e.g. gemma4-31b) or provider (e.g. tinfoil).
					try {
						captureException(error, {
							tags: {
								model: modelForTags,
								base_url: baseURLForTags,
								error_path: 'openai_streaming',
								status: String(error?.status ?? 'unknown'),
							},
							level: 'warning',
						});
					} catch {}
					const errorMessage = error?.message || 'Unknown streaming error';
					const errorStatus = error?.status || 500;
					try {
						controller.enqueue(
							new TextEncoder().encode(
								`data: ${JSON.stringify({
									error: {
										message: errorMessage,
										type: error?.error?.type || 'api_error',
										code: String(errorStatus),
									},
								})}\n\n`
							)
						);
						controller.enqueue(new TextEncoder().encode('data: [DONE]\n\n'));
						controller.close();
					} catch {
						controller.error(error);
					}
				}
			},
			cancel() {
				stream.controller.abort();
			}
		});
	}

	formatMessages(messages: Message[]): ChatCompletionMessage[] {
		return messages.map(
			(msg) =>
				({
					role: msg.role,
					content: Array.isArray(msg.content)
						? msg.content.map((part) => {
								// OpenAI image_url format (from Pi's convertToLlm)
								if (part.type === 'image_url' && part.image_url?.url) {
									return {
										type: 'image_url',
										image_url: {
											url: part.image_url.url,
											detail: part.image_url.detail || 'auto',
										},
									};
								}
								// Pi native format: { type: "image", data: "base64...", mimeType: "image/png" }
								if (part.type === 'image' && part.data && part.mimeType) {
									return {
										type: 'image_url',
										image_url: {
											url: `data:${part.mimeType};base64,${part.data}`,
											detail: 'auto',
										},
									};
								}
								// Anthropic base64 format
								if (part.type === 'image' && part.source?.type === 'base64') {
									return {
										type: 'image_url',
										image_url: {
											url: `data:${part.source.media_type || part.source.mediaType || 'image/png'};base64,${part.source.data}`,
											detail: 'auto',
										},
									};
								}
								// Legacy: { type: "image", image: { url: "..." } }
								if (part.type === 'image' && part.image?.url) {
									return {
										type: 'image_url',
										image_url: {
											url: part.image.url,
											detail: 'auto',
										},
									};
								}
								return { type: 'text', text: part.text || '' };
						  })
						: msg.content,
					tool_calls: msg.tool_calls,
					name: msg.name,
					refusal: null,
				} as ChatCompletionMessage)
		);
	}

	formatResponse(response: any): any {
		return {
			choices: [
				{
					message: {
						content: response.choices[0].message.content,
						role: 'assistant',
						tool_calls: response.choices[0].message.tool_calls,
					},
				},
			],
		};
	}

	async listModels(): Promise<{ id: string; name: string; provider: string }[]> {
		try {
			const response = await this.client.models.list();
			const sixMonthsAgo = new Date();
			sixMonthsAgo.setMonth(sixMonthsAgo.getMonth() - 6);

			return response.data
				.filter((model) => {
					// Filter out non-LLM models
					const isNonLLM =
						model.id.includes('dall-e') || model.id.includes('whisper') || model.id.includes('tts') || model.id.includes('embedding');
					if (isNonLLM) return false;

					// Check if model is recent (created within last 6 months)
					const createdAt = new Date(model.created * 1000); // Convert Unix timestamp to Date
					return createdAt > sixMonthsAgo;
				})
				.map((model) => ({
					id: model.id,
					name: model.id,
					provider: 'openai',
				}));
		} catch (error) {
			console.error('Failed to fetch OpenAI models:', error);
			return [];
		}
	}
}
