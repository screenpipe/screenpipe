import { AIProvider } from './base';
import { Message, RequestBody } from '../types';

// Service account credentials structure (shared with vertex.ts)
interface ServiceAccountCredentials {
	type: string;
	project_id: string;
	private_key_id: string;
	private_key: string;
	client_email: string;
	client_id: string;
	auth_uri: string;
	token_uri: string;
	auth_provider_x509_cert_url: string;
	client_x509_cert_url: string;
}

// Cache for access tokens
interface TokenCache {
	accessToken: string;
	expiresAt: number;
}

let geminiTokenCache: TokenCache | null = null;

export class GeminiProvider implements AIProvider {
	supportsTools = true;
	supportsVision = true;
	supportsJson = true;

	private credentials: ServiceAccountCredentials;
	private projectId: string;
	private region: string;

	constructor(serviceAccountJson: string, projectId: string, region: string = 'us-central1') {
		this.credentials = JSON.parse(serviceAccountJson);
		this.projectId = projectId || this.credentials.project_id;
		this.region = region;
	}

	// Check if web search is requested in tools
	private hasWebSearchTool(tools?: any[]): boolean {
		if (!tools) return false;
		return tools.some(tool =>
			tool.type === 'web_search' ||
			tool.type === 'google_search' ||
			tool.googleSearch !== undefined ||
			(tool.function?.name === 'web_search') ||
			(tool.function?.name === 'google_search')
		);
	}

	/**
	 * Detect if user is explicitly asking for web search
	 * Fallback for when frontend doesn't send web_search tool
	 */
	private detectWebSearchIntent(messages: Message[]): string | null {
		const lastUserMsg = [...messages].reverse().find(m => m.role === 'user');
		if (!lastUserMsg) return null;

		const content = typeof lastUserMsg.content === 'string'
			? lastUserMsg.content.toLowerCase()
			: '';

		const webSearchPatterns = [
			/search\s+(.+?)\s+on\s+(?:the\s+)?(?:internet|web)/i,
			/search\s+(?:the\s+)?(?:internet|web)\s+(?:for|about)\s+(.+)/i,
			/(?:use\s+)?(?:internet|web)\s+search/i,
			/search\s+(?:the\s+)?(?:internet|web)/i,
		];

		for (const pattern of webSearchPatterns) {
			const match = content.match(pattern);
			if (match) {
				// Extract query from match or use full content
				const query = match[1]?.trim().replace(/[?.!]+$/, '') ||
					content.replace(/search|internet|web|the|for|about|use/gi, '').trim();
				if (query.length > 2) {
					console.log('[Gemini Vertex] Web search intent detected:', query);
					return query;
				}
			}
		}

		return null;
	}


	/**
	 * Generate a JWT for service account authentication
	 */
	private async generateJWT(): Promise<string> {
		const header = {
			alg: 'RS256',
			typ: 'JWT',
		};

		const now = Math.floor(Date.now() / 1000);
		const payload = {
			iss: this.credentials.client_email,
			sub: this.credentials.client_email,
			aud: 'https://oauth2.googleapis.com/token',
			iat: now,
			exp: now + 3600, // 1 hour
			scope: 'https://www.googleapis.com/auth/cloud-platform',
		};

		const encodedHeader = this.base64urlEncode(JSON.stringify(header));
		const encodedPayload = this.base64urlEncode(JSON.stringify(payload));
		const signatureInput = `${encodedHeader}.${encodedPayload}`;

		const signature = await this.signWithRSA(signatureInput, this.credentials.private_key);
		return `${signatureInput}.${signature}`;
	}

	private base64urlEncode(str: string): string {
		const base64 = btoa(str);
		return base64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
	}

	private async signWithRSA(data: string, privateKeyPem: string): Promise<string> {
		const pemContents = privateKeyPem
			.replace('-----BEGIN PRIVATE KEY-----', '')
			.replace('-----END PRIVATE KEY-----', '')
			.replace(/\n/g, '');

		const binaryKey = Uint8Array.from(atob(pemContents), (c) => c.charCodeAt(0));

		const cryptoKey = await crypto.subtle.importKey(
			'pkcs8',
			binaryKey,
			{
				name: 'RSASSA-PKCS1-v1_5',
				hash: 'SHA-256',
			},
			false,
			['sign']
		);

		const encoder = new TextEncoder();
		const signature = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', cryptoKey, encoder.encode(data));

		const signatureArray = new Uint8Array(signature);
		const signatureBase64 = btoa(String.fromCharCode(...signatureArray));
		return signatureBase64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
	}

	private async getAccessToken(): Promise<string> {
		// Check cache
		if (geminiTokenCache && geminiTokenCache.expiresAt > Date.now() + 60000) {
			return geminiTokenCache.accessToken;
		}

		const jwt = await this.generateJWT();

		const response = await fetch('https://oauth2.googleapis.com/token', {
			method: 'POST',
			headers: {
				'Content-Type': 'application/x-www-form-urlencoded',
			},
			body: new URLSearchParams({
				grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
				assertion: jwt,
			}),
		});

		if (!response.ok) {
			const error = await response.text();
			throw new Error(`Failed to get access token: ${error}`);
		}

		const data = (await response.json()) as { access_token: string; expires_in: number };

		geminiTokenCache = {
			accessToken: data.access_token,
			expiresAt: Date.now() + data.expires_in * 1000,
		};

		return data.access_token;
	}

	private getEndpointUrl(model: string, streaming: boolean = false): string {
		const method = streaming ? 'streamGenerateContent' : 'generateContent';
		// Map model names to Vertex AI format
		const vertexModel = this.mapModelToVertex(model);
		// Gemini 3+ models require the global endpoint, older models use regional
		const isGlobal = vertexModel.startsWith('gemini-3');
		if (isGlobal) {
			return `https://aiplatform.googleapis.com/v1/projects/${this.projectId}/locations/global/publishers/google/models/${vertexModel}:${method}`;
		}
		return `https://${this.region}-aiplatform.googleapis.com/v1/projects/${this.projectId}/locations/${this.region}/publishers/google/models/${vertexModel}:${method}`;
	}

	private mapModelToVertex(model: string): string {
		// Map friendly model names to Vertex AI model IDs
		const modelMap: Record<string, string> = {
			'gemini-flash': 'gemini-2.5-flash',
			'gemini-pro': 'gemini-2.5-pro',
			'gemini-3-flash': 'gemini-3-flash-preview',
			'gemini-3-pro': 'gemini-3.1-pro-preview',
			'gemini-3.1-pro': 'gemini-3.1-pro-preview',
		};
		const mapped = modelMap[model] || model;
		console.log('[Gemini Vertex] Model mapping:', model, '->', mapped);
		return mapped;
	}

	async createCompletion(body: RequestBody): Promise<Response> {
		const accessToken = await this.getAccessToken();
		const url = this.getEndpointUrl(body.model, false);
		const hasWebSearch = this.hasWebSearchTool(body.tools);

		let requestBody = this.buildRequestBody(body, hasWebSearch);

		console.log('[Gemini Vertex] Request to:', url);

		const response = await fetch(url, {
			method: 'POST',
			headers: {
				'Authorization': `Bearer ${accessToken}`,
				'Content-Type': 'application/json',
			},
			body: JSON.stringify(requestBody),
		});

		if (!response.ok) {
			const error = await response.text();
			console.error('[Gemini Vertex] Error:', error);
			throw new Error(`Gemini Vertex AI request failed: ${response.status} ${error}`);
		}

		let result: any = await response.json();

		// Check if model called web_search - if so, execute it and continue
		const parts = result.candidates?.[0]?.content?.parts || [];
		const webSearchCall = parts.find((p: any) =>
			p.functionCall?.name === 'web_search' || p.functionCall?.name === 'google_search'
		);

		if (webSearchCall) {
			const query = webSearchCall.functionCall.args?.query || webSearchCall.functionCall.args?.q || '';
			console.log('[Gemini Vertex] Model called web_search, executing for:', query);

			try {
				const searchResult = await this.executeWebSearch(query);

				// Build follow-up request with the search result
				const followUpContents = [
					...requestBody.contents,
					{
						role: 'model',
						parts: [{ functionCall: webSearchCall.functionCall }],
					},
					{
						role: 'user',
						parts: [{
							functionResponse: {
								name: 'web_search',
								response: { result: searchResult.content },
							},
						}],
					},
				];

				const followUpResponse = await fetch(url, {
					method: 'POST',
					headers: {
						'Authorization': `Bearer ${accessToken}`,
						'Content-Type': 'application/json',
					},
					body: JSON.stringify({
						contents: followUpContents,
						generationConfig: requestBody.generationConfig,
					}),
				});

				if (followUpResponse.ok) {
					result = await followUpResponse.json();
				}
			} catch (error) {
				console.error('[Gemini Vertex] Web search execution failed:', error);
				// Return the original response with the tool call
			}
		}

		return new Response(JSON.stringify(this.formatResponse(result, false)), {
			headers: { 'Content-Type': 'application/json' },
		});
	}

	async createStreamingCompletion(body: RequestBody): Promise<ReadableStream> {
		const accessToken = await this.getAccessToken();
		const hasWebSearch = this.hasWebSearchTool(body.tools);

		// Fallback: detect web search intent when frontend doesn't send web_search tool
		if (!hasWebSearch) {
			const webSearchQuery = this.detectWebSearchIntent(body.messages);
			if (webSearchQuery) {
				console.log('[Gemini Vertex] Fallback web search for:', webSearchQuery);
				return this.createDirectWebSearchStream(webSearchQuery);
			}
		}

		const url = this.getEndpointUrl(body.model, true) + '?alt=sse';
		const requestBody = this.buildRequestBody(body, hasWebSearch);

		console.log('[Gemini Vertex] Streaming request to:', url);
		console.log('[Gemini Vertex] Request body:', JSON.stringify({
			hasSystemInstruction: !!requestBody.systemInstruction,
			hasTools: !!(requestBody.tools?.length),
			toolNames: requestBody.tools?.[0]?.functionDeclarations?.map((f: any) => f.name) || [],
			hasToolConfig: !!requestBody.toolConfig,
		}));

		const response = await fetch(url, {
			method: 'POST',
			headers: {
				'Authorization': `Bearer ${accessToken}`,
				'Content-Type': 'application/json',
			},
			body: JSON.stringify(requestBody),
		});

		if (!response.ok) {
			const error = await response.text();
			console.error('[Gemini Vertex] Streaming error:', error);
			throw new Error(`Gemini Vertex AI streaming request failed: ${response.status} ${error}`);
		}

		const reader = response.body!.getReader();
		const decoder = new TextDecoder();
		let buffer = '';
		const self = this;

		let toolCallIndex = 0;
		let pendingWebSearch: { name: string; args: any } | null = null;

		return new ReadableStream({
			async start(controller) {
				try {
					while (true) {
						const { done, value } = await reader.read();
						if (done) {
							// Before closing, check if we have a pending web search to execute
							if (pendingWebSearch) {
								const query = pendingWebSearch.args?.query || pendingWebSearch.args?.q || '';
								console.log('[Gemini Vertex] Executing pending web_search:', query);

								// Stream a searching indicator
								controller.enqueue(
									new TextEncoder().encode(
										`data: ${JSON.stringify({
											choices: [{ delta: { content: `\n\n*Searching the web for "${query}"...*\n\n` } }],
										})}\n\n`
									)
								);

								try {
									const searchResult = await self.executeWebSearch(query);

									// Stream the search result as content
									controller.enqueue(
										new TextEncoder().encode(
											`data: ${JSON.stringify({
												choices: [{ delta: { content: '\n\n' + searchResult.content } }],
											})}\n\n`
										)
									);
								} catch (error) {
									console.error('[Gemini Vertex] Web search failed:', error);
									controller.enqueue(
										new TextEncoder().encode(
											`data: ${JSON.stringify({
												choices: [{ delta: { content: '\n\nWeb search failed. Please try again.' } }],
											})}\n\n`
										)
									);
								}

								// Send proper finish_reason after web search completes
								controller.enqueue(
									new TextEncoder().encode(
										`data: ${JSON.stringify({
											choices: [{ delta: {}, finish_reason: 'stop' }],
										})}\n\n`
									)
								);
							}

							controller.enqueue(new TextEncoder().encode('data: [DONE]\n\n'));
							controller.close();
							return;
						}

						buffer += decoder.decode(value, { stream: true });
						const lines = buffer.split('\n');
						buffer = lines.pop() || '';

						for (const line of lines) {
							if (line.startsWith('data: ')) {
								try {
									const data = JSON.parse(line.slice(6));
									const parts = data.candidates?.[0]?.content?.parts || [];

									for (const part of parts) {
										// Handle text content
										if (part.text) {
											controller.enqueue(
												new TextEncoder().encode(
													`data: ${JSON.stringify({
														choices: [{ delta: { content: part.text } }],
													})}\n\n`
												)
											);
										}

										// Handle function calls
										if (part.functionCall) {
											const funcName = part.functionCall.name;
											console.log('[Gemini Vertex] Model called function:', funcName, JSON.stringify(part.functionCall.args || {}));

											// If it's web_search, save it for execution after stream ends
											if (funcName === 'web_search' || funcName === 'google_search') {
												pendingWebSearch = {
													name: funcName,
													args: part.functionCall.args || {},
												};
												console.log('[Gemini Vertex] Saving web_search for execution after stream ends');
												// Don't emit the tool call - we'll handle it ourselves
											} else {
												// For other tools, emit the tool call for client to handle
												// Encode thoughtSignature into the ID so it survives OpenAI format round-trip
												const sig = part.thoughtSignature || '';
												const toolCallId = sig
													? `call_${toolCallIndex}_ts_${btoa(sig)}`
													: `call_${Date.now()}_${toolCallIndex}`;
												controller.enqueue(
													new TextEncoder().encode(
														`data: ${JSON.stringify({
															choices: [{
																delta: {
																	tool_calls: [{
																		index: toolCallIndex,
																		id: toolCallId,
																		type: 'function',
																		function: {
																			name: funcName,
																			arguments: JSON.stringify(part.functionCall.args || {}),
																		},
																	}],
																},
															}],
														})}\n\n`
													)
												);
												toolCallIndex++;
											}
										}
									}

									// Check for finish reason
									const finishReason = data.candidates?.[0]?.finishReason;
									if (finishReason) {
										// If we have a pending web search, don't send 'tool_calls' finish reason
										// because we'll handle the tool ourselves
										if (pendingWebSearch && finishReason === 'TOOL_USE') {
											console.log('[Gemini Vertex] Suppressing tool_calls finish_reason for web_search');
											// Don't emit finish_reason yet - we'll send 'stop' after web search completes
										} else {
											const mappedReason = finishReason === 'STOP' ? 'stop' :
												finishReason === 'MAX_TOKENS' ? 'length' :
												finishReason === 'TOOL_USE' ? 'tool_calls' : 'stop';
											controller.enqueue(
												new TextEncoder().encode(
													`data: ${JSON.stringify({
														choices: [{ delta: {}, finish_reason: mappedReason }],
													})}\n\n`
												)
											);
										}
									}
								} catch (e) {
									// Skip invalid JSON
								}
							}
						}
					}
				} catch (error: any) {
					console.error('[Gemini Vertex] Stream error:', error);
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
		});
	}

	private buildRequestBody(body: RequestBody, _hasWebSearch: boolean): any {
		// Extract system message for systemInstruction
		const systemMsg = body.messages.find(m => m.role === 'system');
		const contents = this.formatMessages(body.messages);

		const requestBody: any = {
			contents,
			generationConfig: {
				temperature: body.temperature ?? 0.7,
			},
		};

		// Add system instruction properly (Gemini's native way)
		if (systemMsg) {
			const systemText = typeof systemMsg.content === 'string' ? systemMsg.content : '';
			if (systemText) {
				requestBody.systemInstruction = {
					parts: [{ text: systemText }],
				};
				console.log('[Gemini Vertex] System instruction set');
			}
		}

		// Add response format if specified
		if (body.response_format?.type === 'json_schema' && body.response_format.schema) {
			requestBody.generationConfig.responseMimeType = 'application/json';
			requestBody.generationConfig.responseSchema = body.response_format.schema;
		} else if (body.response_format?.type === 'json_object') {
			requestBody.generationConfig.responseMimeType = 'application/json';
		}

		// Always send function declarations - let the model decide which tool to use
		// When model calls web_search, we'll execute it via Google Search grounding in a follow-up
		if (body.tools && body.tools.length > 0) {
			const functionDeclarations = this.convertToolsToGeminiFormat(body.tools);
			if (functionDeclarations.length > 0) {
				requestBody.tools = [{ functionDeclarations }];
				// Enable automatic function calling mode
				requestBody.toolConfig = {
					functionCallingConfig: {
						mode: 'AUTO',
					},
				};
				console.log('[Gemini Vertex] Tools available:', functionDeclarations.map(f => f.name));
			}
		}

		return requestBody;
	}

	/**
	 * Convert OpenAI-style function tools to Gemini functionDeclarations format
	 */
	private convertToolsToGeminiFormat(tools: any[]): any[] {
		const functionDeclarations: any[] = [];

		for (const tool of tools) {
			// Convert OpenAI function format to Gemini format
			if (tool.type === 'function' && tool.function) {
				functionDeclarations.push({
					name: tool.function.name,
					description: tool.function.description || '',
					parameters: this.convertParametersToGeminiSchema(tool.function.parameters),
				});
			}
		}

		return functionDeclarations;
	}

	/**
	 * Execute a web search using Google Search grounding
	 * Called when the model decides to use the web_search tool
	 */
	async executeWebSearch(query: string): Promise<{ content: string; sources: any[] }> {
		const accessToken = await this.getAccessToken();
		const url = this.getEndpointUrl('gemini-2.0-flash', false);

		const requestBody = {
			contents: [{
				role: 'user',
				parts: [{ text: `Search the web and provide information about: ${query}` }],
			}],
			tools: [{ googleSearch: {} }],
			generationConfig: {
				temperature: 0.7,
			},
		};

		console.log('[Gemini Vertex] Executing web search for:', query);

		const response = await fetch(url, {
			method: 'POST',
			headers: {
				'Authorization': `Bearer ${accessToken}`,
				'Content-Type': 'application/json',
			},
			body: JSON.stringify(requestBody),
		});

		if (!response.ok) {
			const error = await response.text();
			console.error('[Gemini Vertex] Web search error:', error);
			throw new Error(`Web search failed: ${response.status}`);
		}

		const result: any = await response.json();
		const parts = result.candidates?.[0]?.content?.parts || [];
		const groundingMetadata = result.candidates?.[0]?.groundingMetadata;

		let content = parts.map((p: any) => p.text || '').join('');

		// Append sources
		if (groundingMetadata?.groundingChunks?.length) {
			content += '\n\n**Sources:**\n';
			for (const chunk of groundingMetadata.groundingChunks) {
				if (chunk.web?.uri) {
					content += `- [${chunk.web.title || chunk.web.uri}](${chunk.web.uri})\n`;
				}
			}
		}

		const sources = (groundingMetadata?.groundingChunks || []).map((chunk: any) => ({
			title: chunk.web?.title,
			url: chunk.web?.uri,
		}));

		return { content, sources };
	}

	/**
	 * Create a streaming response for direct web search (fallback)
	 */
	private async createDirectWebSearchStream(query: string): Promise<ReadableStream> {
		const self = this;
		return new ReadableStream({
			async start(controller) {
				try {
					controller.enqueue(
						new TextEncoder().encode(
							`data: ${JSON.stringify({
								choices: [{ delta: { content: `*Searching the web for "${query}"...*\n\n` } }],
							})}\n\n`
						)
					);

					const searchResult = await self.executeWebSearch(query);

					controller.enqueue(
						new TextEncoder().encode(
							`data: ${JSON.stringify({
								choices: [{ delta: { content: searchResult.content } }],
							})}\n\n`
						)
					);

					controller.enqueue(
						new TextEncoder().encode(
							`data: ${JSON.stringify({
								choices: [{ delta: {}, finish_reason: 'stop' }],
							})}\n\n`
						)
					);

					controller.enqueue(new TextEncoder().encode('data: [DONE]\n\n'));
					controller.close();
				} catch (error) {
					console.error('[Gemini Vertex] Direct web search failed:', error);
					controller.enqueue(
						new TextEncoder().encode(
							`data: ${JSON.stringify({
								choices: [{ delta: { content: 'Web search failed. Please try again.' } }],
							})}\n\n`
						)
					);
					controller.enqueue(new TextEncoder().encode('data: [DONE]\n\n'));
					controller.close();
				}
			},
		});
	}

	/**
	 * Convert OpenAI JSON Schema parameters to Gemini schema format
	 */
	private convertParametersToGeminiSchema(params: any): any {
		if (!params) return { type: 'OBJECT', properties: {} };

		const converted: any = {
			type: (params.type || 'object').toUpperCase(),
		};

		if (params.properties) {
			converted.properties = {};
			for (const [key, value] of Object.entries(params.properties as Record<string, any>)) {
				converted.properties[key] = {
					type: (value.type || 'string').toUpperCase(),
					description: value.description || '',
				};
				// Handle enum
				if (value.enum) {
					converted.properties[key].enum = value.enum;
				}
			}
		}

		if (params.required && Array.isArray(params.required)) {
			converted.required = params.required;
		}

		return converted;
	}

	formatMessages(messages: Message[]): any[] {
		const formatted: any[] = [];

		// Collect consecutive tool responses to batch them into a single user message
		// (Gemini requires all functionResponse parts in one message matching the functionCall turn)
		let pendingToolResponses: any[] = [];

		const flushToolResponses = () => {
			if (pendingToolResponses.length > 0) {
				formatted.push({
					role: 'user',
					parts: pendingToolResponses,
				});
				pendingToolResponses = [];
			}
		};

		for (const msg of messages) {
			if (msg.role === 'system') {
				// System messages are handled via systemInstruction in buildRequestBody
				continue;
			}

			// Handle tool results - collect consecutive ones into a single user message
			if (msg.role === 'tool') {
				const toolMsg = msg as any;
				pendingToolResponses.push({
					functionResponse: {
						name: toolMsg.name || 'unknown_function',
						response: {
							result: typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content),
						},
					},
				});
				continue;
			}

			// Flush any pending tool responses before processing non-tool message
			flushToolResponses();

			const role = msg.role === 'assistant' ? 'model' : 'user';
			const parts: any[] = [];

			// Handle text content
			if (typeof msg.content === 'string') {
				parts.push({ text: msg.content });
			} else if (Array.isArray(msg.content)) {
				for (const part of msg.content) {
					if (part.type === 'text') {
						parts.push({ text: part.text || '' });
					} else if (part.type === 'image_url' && part.image_url?.url) {
						// Handle OpenAI vision format (image_url with base64 or URL)
						const url = part.image_url.url;
						const dataUrlMatch = url.match(/^data:([^;]+);base64,(.+)$/);
						if (dataUrlMatch) {
							parts.push({
								inlineData: {
									mimeType: dataUrlMatch[1],
									data: dataUrlMatch[2],
								},
							});
						} else {
							// Handle external URLs
							parts.push({
								fileData: {
									mimeType: 'image/jpeg', // Default, Gemini will detect
									fileUri: url,
								},
							});
						}
					} else if (part.type === 'image' && part.image?.url) {
						// Legacy format support
						const url = part.image.url;
						const dataUrlMatch = url.match(/^data:([^;]+);base64,(.+)$/);
						if (dataUrlMatch) {
							parts.push({
								inlineData: {
									mimeType: dataUrlMatch[1],
									data: dataUrlMatch[2],
								},
							});
						}
					}
				}
			}

			// Handle assistant messages with tool calls - convert to Gemini functionCall format
			// Restore thoughtSignature from encoded tool call IDs for Gemini 3+ models
			if (msg.role === 'assistant' && (msg as any).tool_calls) {
				for (const toolCall of (msg as any).tool_calls) {
					const callPart: any = {
						functionCall: {
							name: toolCall.function?.name || toolCall.name,
							args: typeof toolCall.function?.arguments === 'string'
								? JSON.parse(toolCall.function.arguments)
								: toolCall.function?.arguments || {},
						},
					};
					// Extract thoughtSignature from encoded tool call ID
					const tsMatch = (toolCall.id || '').match(/_ts_(.+)$/);
					if (tsMatch) {
						try {
							callPart.thoughtSignature = atob(tsMatch[1]);
						} catch {}
					}
					parts.push(callPart);
				}
			}

			if (parts.length > 0) {
				formatted.push({ role, parts });
			}
		}

		// Flush any remaining tool responses at end of messages
		flushToolResponses();

		return formatted;
	}

	private formatGroundingSources(groundingMetadata: any): string {
		if (!groundingMetadata?.groundingChunks?.length) return '';

		let sourcesText = '\n\n---\n**Sources:**\n';
		for (const chunk of groundingMetadata.groundingChunks) {
			if (chunk.web?.uri) {
				sourcesText += `- [${chunk.web.title || chunk.web.uri}](${chunk.web.uri})\n`;
			}
		}
		return sourcesText;
	}

	formatResponse(response: any, includeGrounding: boolean = false): any {
		const parts = response.candidates?.[0]?.content?.parts || [];

		// Extract text content
		let content = '';
		const toolCalls: any[] = [];

		for (const part of parts) {
			if (part.text) {
				content += part.text;
			}
			// Handle Gemini function calls - convert to OpenAI format
			// Encode thoughtSignature into ID for round-trip preservation
			if (part.functionCall) {
				const sig = part.thoughtSignature || '';
				const callId = sig
					? `call_${toolCalls.length}_ts_${btoa(sig)}`
					: `call_${Date.now()}_${toolCalls.length}`;
				toolCalls.push({
					id: callId,
					type: 'function',
					function: {
						name: part.functionCall.name,
						arguments: JSON.stringify(part.functionCall.args || {}),
					},
				});
			}
		}

		// If grounding was used, append sources
		if (includeGrounding) {
			const groundingMetadata = response.candidates?.[0]?.groundingMetadata;
			content += this.formatGroundingSources(groundingMetadata);
		}

		const message: any = {
			content: content || null,
			role: 'assistant',
		};

		// Add tool_calls if any function calls were made
		if (toolCalls.length > 0) {
			message.tool_calls = toolCalls;
		}

		const result: any = {
			choices: [{ message }],
		};

		// Include grounding metadata in response for clients that want it
		if (includeGrounding) {
			const groundingMetadata = response.candidates?.[0]?.groundingMetadata;
			if (groundingMetadata) {
				result.grounding_metadata = {
					search_queries: groundingMetadata.webSearchQueries || [],
					sources: (groundingMetadata.groundingChunks || []).map((chunk: any) => ({
						title: chunk.web?.title,
						url: chunk.web?.uri,
					})),
				};
			}
		}

		return result;
	}

	async listModels(): Promise<{ id: string; name: string; provider: string }[]> {
		// Return available Gemini models on Vertex AI
		return [
			{ id: 'gemini-2.0-flash', name: 'Gemini 2.0 Flash', provider: 'google' },
			{ id: 'gemini-2.0-pro-exp-02-05', name: 'Gemini 2.0 Pro', provider: 'google' },
			{ id: 'gemini-3-flash', name: 'Gemini 3 Flash', provider: 'google' },
			{ id: 'gemini-3.1-pro', name: 'Gemini 3.1 Pro', provider: 'google' },
		];
	}
}
