import { createErrorResponse } from './cors';
import { Env, UserTier, AuthResult } from '../types';
import { getTierConfig } from '../services/usage-tracker';

export class RateLimiter {
  private state: DurableObjectState;
  private requests: Map<string, { count: number; lastReset: number }>;

  constructor(state: DurableObjectState) {
    this.state = state;
    this.requests = new Map();
  }

  /**
   * Handles fetch requests to check and update rate limits
   * @param request The HTTP request
   * @returns Response with rate limit status
   */
  async fetch(request: Request) {
    const url = new URL(request.url);
    const now = Date.now();

    // Get identifier and tier from URL params (passed by checkRateLimit)
    const identifier = url.searchParams.get('id') || 'unknown';
    const tier = (url.searchParams.get('tier') || 'anonymous') as UserTier;

    // Get tier-specific RPM limit (prefer override from query param, fall back to defaults)
    const rpmOverride = url.searchParams.get('rpm');
    const tierRpm = rpmOverride ? parseInt(rpmOverride) : (getTierConfig()[tier]?.rpm || 5);

    // Endpoint-specific limits (as multipliers of base RPM)
    const endpointMultipliers: Record<string, number> = {
      '/v1/chat/completions': 1,
      '/v1/voice/transcribe': 0.75,
      '/v1/voice/query': 0.5,
      '/v1/text-to-speech': 0.75,
      '/v1/voice/chat': 0.4,
    };

    const multiplier = endpointMultipliers[url.pathname] || 1;
    const effectiveRpm = Math.max(1, Math.floor(tierRpm * multiplier));
    const window = 60000; // 1 minute

    let tracking = this.requests.get(identifier) || { count: 0, lastReset: now };

    if (now - tracking.lastReset > window) {
      tracking = { count: 0, lastReset: now };
    }

    tracking.count++;
    this.requests.set(identifier, tracking);

    const isAllowed = tracking.count <= effectiveRpm;

    return new Response(
      JSON.stringify({
        allowed: isAllowed,
        remaining: Math.max(0, effectiveRpm - tracking.count),
        reset_in: Math.ceil((tracking.lastReset + window - now) / 1000),
        tier,
        rpm_limit: effectiveRpm,
      })
    );
  }
}

/**
 * Checks if the request exceeds rate limits
 * @param request The HTTP request
 * @param env Environment variables
 * @param authResult Optional auth result with tier info
 * @returns Object indicating if request is allowed and optional error response
 */
export async function checkRateLimit(
  request: Request,
  env: Env,
  authResult?: AuthResult
): Promise<{ allowed: boolean; response?: Response }> {
  // Use device ID if available, fall back to IP
  const identifier = authResult?.deviceId ||
    request.headers.get('X-Device-Id') ||
    request.headers.get('cf-connecting-ip') ||
    'unknown';

  const tier = authResult?.tier || 'anonymous';

  const rateLimiterId = env.RATE_LIMITER.idFromName(identifier);
  const rateLimiter = env.RATE_LIMITER.get(rateLimiterId);

  // Pass tier info and resolved RPM to the rate limiter
  const url = new URL(request.url);
  url.searchParams.set('id', identifier);
  url.searchParams.set('tier', tier);
  url.searchParams.set('rpm', String(getTierConfig(env)[tier]?.rpm || 5));

  let rateLimitResponse: Response;
  try {
    rateLimitResponse = await rateLimiter.fetch(url.toString());
  } catch (err: any) {
    console.error('rate limiter durable object error, failing open:', err?.message);
    return { allowed: true };
  }

  if (!rateLimitResponse.ok) {
    console.error('rate limiter returned status', rateLimitResponse.status);
    return { allowed: true };
  }

  let rateLimitData: {
    allowed: boolean;
    remaining: number;
    reset_in: number;
    tier: string;
    rpm_limit: number;
  };
  try {
    rateLimitData = await rateLimitResponse.json();
  } catch (err: any) {
    console.error('rate limiter response parse error, failing open:', err?.message);
    return { allowed: true };
  }

  if (!rateLimitData.allowed) {
    return {
      allowed: false,
      response: createErrorResponse(429, JSON.stringify({
        error: 'rate limit exceeded',
        message: `You've exceeded ${rateLimitData.rpm_limit} requests per minute. Please wait ${rateLimitData.reset_in} seconds.`,
        tier: rateLimitData.tier,
        reset_in: rateLimitData.reset_in,
      }))
    };
  }

  return { allowed: true };
}
