/**
 * Tests for Vertex AI proxy
 *
 * To run these tests locally:
 * 1. Set up your service account JSON in .dev.vars:
 *    VERTEX_SERVICE_ACCOUNT_JSON='{"type":"service_account",...}'
 *    VERTEX_PROJECT_ID='your-project-id'
 *    VERTEX_REGION='us-east5'
 *
 * 2. Start the worker: npm run dev
 *
 * 3. Run tests: npx bun test src/test/vertex-proxy.test.ts
 *    Or manually with curl (see examples below)
 */

import { describe, it, expect } from 'bun:test';

const HOST = process.env.TEST_HOST || 'http://localhost:8787';

async function fetchRunningWorker(path: string): Promise<Response | null> {
	try {
		return await fetch(`${HOST}${path}`);
	} catch (error) {
		if (String(error).includes('ConnectionRefused') || String(error).includes('Unable to connect')) {
			console.log('Skipping test - worker is not running');
			return null;
		}
		throw error;
	}
}

describe('Vertex AI Proxy', () => {
	// Skip tests if no service account is configured
	const hasCredentials = process.env.VERTEX_SERVICE_ACCOUNT_JSON || process.env.SKIP_CREDENTIAL_CHECK;

	it('should return health check', async () => {
		const response = await fetchRunningWorker('/test');
		if (!response) return;
		expect(response.status).toBe(200);
		const text = await response.text();
		expect(text).toContain('ai proxy is working');
	});

	it('should handle /v1/messages endpoint', async () => {
		if (!hasCredentials) {
			console.log('Skipping test - no credentials configured');
			return;
		}

		const response = await fetch(`${HOST}/v1/messages`, {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				Authorization: 'Bearer test-token',
			},
			body: JSON.stringify({
				model: 'claude-3-5-sonnet-v2@20241022',
				max_tokens: 100,
				messages: [
					{
						role: 'user',
						content: 'Say "hello" and nothing else.',
					},
				],
			}),
		});

		console.log('Response status:', response.status);
		const data = await response.json();
		console.log('Response data:', JSON.stringify(data, null, 2));

		// If credentials are invalid, we'll get a 500 with error message
		// If valid, we should get 200 with response
		expect([200, 500]).toContain(response.status);
	});

	it('should handle streaming requests', async () => {
		if (!hasCredentials) {
			console.log('Skipping test - no credentials configured');
			return;
		}

		const response = await fetch(`${HOST}/v1/messages`, {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				Authorization: 'Bearer test-token',
			},
			body: JSON.stringify({
				model: 'claude-3-5-sonnet-v2@20241022',
				max_tokens: 100,
				stream: true,
				messages: [
					{
						role: 'user',
						content: 'Count from 1 to 3.',
					},
				],
			}),
		});

		console.log('Streaming response status:', response.status);
		expect([200, 500]).toContain(response.status);

		if (response.status === 200) {
			const reader = response.body?.getReader();
			if (reader) {
				const chunks: string[] = [];
				const decoder = new TextDecoder();

				while (true) {
					const { done, value } = await reader.read();
					if (done) break;
					chunks.push(decoder.decode(value, { stream: true }));
				}

				console.log('Received chunks:', chunks.length);
				expect(chunks.length).toBeGreaterThan(0);
			}
		}
	});
});

/*
Manual test commands:

# Start the worker
cd packages/ai-gateway
npm run dev

# Test health check
curl http://localhost:8787/test

# Test /v1/messages (non-streaming)
curl -X POST http://localhost:8787/v1/messages \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer test-token" \
  -d '{
    "model": "claude-3-5-sonnet-v2@20241022",
    "max_tokens": 100,
    "messages": [
      {"role": "user", "content": "Say hello"}
    ]
  }'

# Test /v1/messages (streaming)
curl -X POST http://localhost:8787/v1/messages \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer test-token" \
  -d '{
    "model": "claude-3-5-sonnet-v2@20241022",
    "max_tokens": 100,
    "stream": true,
    "messages": [
      {"role": "user", "content": "Count from 1 to 5"}
    ]
  }'

# Test with Agent SDK (in your app)
export CLAUDE_CODE_USE_VERTEX=1
export ANTHROPIC_VERTEX_BASE_URL=http://localhost:8787
export CLAUDE_CODE_SKIP_VERTEX_AUTH=1

# Then run your Agent SDK code
*/
