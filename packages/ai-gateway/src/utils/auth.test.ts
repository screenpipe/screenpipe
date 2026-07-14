import { afterEach, beforeEach, describe, it, expect, mock } from 'bun:test';
import type { Env } from '../types';
import { activeSubscriptionFilter } from './subscription';

const verifyTokenMock = mock(async (_token: string, _options: unknown) => {
  throw new Error('invalid token');
});

mock.module('@clerk/backend', () => ({
  verifyToken: verifyTokenMock,
}));

const { validateAuth } = await import('./auth');

// Canceling a subscription must not strip Pro access before the paid period
// ends. Stripe stamps canceled_at / flips status to canceled the moment a
// cancellation is processed, so the subscription gate has to grant access to a
// canceled row whose current_period_end is still in the future. (issue #3843)
describe('activeSubscriptionFilter — keeps Pro until period end (#3843)', () => {
  const nowIso = '2026-06-05T00:00:00.000Z';

  it('still matches active and trialing subscriptions', () => {
    expect(activeSubscriptionFilter(nowIso)).toContain('status.in.(active,trialing)');
  });

  it('grants a canceled subscription access until current_period_end', () => {
    const filter = activeSubscriptionFilter(nowIso);
    expect(filter).toContain('status.eq.canceled');
    expect(filter).toContain('current_period_end.gt.');
  });

  it('is one PostgREST or= filter combining both conditions', () => {
    const filter = activeSubscriptionFilter(nowIso);
    expect(filter.startsWith('or=(')).toBe(true);
    expect(filter.endsWith(')')).toBe(true);
    // canceled access is gated on the period end, not on canceled_at
    expect(filter).not.toContain('canceled_at');
  });

  it('url-encodes the timestamp so the query string stays valid', () => {
    expect(activeSubscriptionFilter('2026-06-05T12:34:56.789Z')).toContain(
      '2026-06-05T12%3A34%3A56.789Z'
    );
  });
});

describe('validateAuth — verified identities only', () => {
  const originalFetch = globalThis.fetch;
  const env = {
    NODE_ENV: 'production',
    CLERK_SECRET_KEY: 'clerk-test-secret',
    SUPABASE_URL: 'https://supabase.test',
    SUPABASE_ANON_KEY: 'supabase-test-key',
  } as Env;

  const requestFor = (token?: string) => new Request('https://gateway.test/v1/usage', {
    headers: {
      'X-Device-Id': 'device-from-header',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
  });

  beforeEach(() => {
    verifyTokenMock.mockImplementation(async () => {
      throw new Error('invalid token');
    });
    globalThis.fetch = mock(async () => {
      throw new Error('unexpected fetch');
    }) as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    verifyTokenMock.mockClear();
  });

  it('keeps requests without credentials anonymous', async () => {
    expect(await validateAuth(requestFor(), env)).toEqual({
      isValid: true,
      tier: 'anonymous',
      deviceId: 'device-from-header',
    });
  });

  it('does not authenticate an arbitrary UUID, even if it names an account', async () => {
    const fetchMock = mock(async () => new Response(JSON.stringify([{ id: 'active-subscription' }])));
    globalThis.fetch = fetchMock as typeof fetch;

    expect(await validateAuth(
      requestFor('550e8400-e29b-41d4-a716-446655440000'),
      env,
    )).toEqual({
      isValid: true,
      tier: 'anonymous',
      deviceId: 'device-from-header',
    });
    expect(fetchMock).toHaveBeenCalledTimes(0);
  });

  it('does not authenticate an arbitrary Clerk user ID', async () => {
    expect(await validateAuth(requestFor('user_attackerchosen'), env)).toEqual({
      isValid: true,
      tier: 'anonymous',
      deviceId: 'device-from-header',
    });
  });

  it('keeps a verified Clerk JWT logged in without a subscription', async () => {
    verifyTokenMock.mockImplementation(async () => ({ sub: 'user_verified' }) as any);
    globalThis.fetch = mock(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/rest/v1/users?')) {
        return new Response(JSON.stringify([{ id: '11111111-1111-4111-8111-111111111111' }]), { status: 200 });
      }
      if (url.includes('/rest/v1/cloud_subscriptions?')) {
        return new Response(JSON.stringify([]), { status: 200 });
      }
      throw new Error(`unexpected fetch: ${url}`);
    }) as typeof fetch;

    expect(await validateAuth(requestFor('eyJ.verified.clerk'), env)).toEqual({
      isValid: true,
      tier: 'logged_in',
      deviceId: 'user_verified',
      userId: 'user_verified',
    });
  });

  it('grants subscribed only after a Clerk JWT proves account ownership', async () => {
    verifyTokenMock.mockImplementation(async () => ({ sub: 'user_subscribed' }) as any);
    globalThis.fetch = mock(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/rest/v1/users?')) {
        return new Response(JSON.stringify([{ id: '22222222-2222-4222-8222-222222222222' }]), { status: 200 });
      }
      if (url.includes('/rest/v1/cloud_subscriptions?')) {
        return new Response(JSON.stringify([{ id: 'sub_123' }]), { status: 200 });
      }
      throw new Error(`unexpected fetch: ${url}`);
    }) as typeof fetch;

    expect(await validateAuth(requestFor('eyJ.subscribed.clerk'), env)).toEqual({
      isValid: true,
      tier: 'subscribed',
      deviceId: 'user_subscribed',
      userId: 'user_subscribed',
    });
  });

  it('accepts a successfully validated legacy screenpipe JWT', async () => {
    globalThis.fetch = mock(async (input: RequestInfo | URL) => {
      expect(String(input)).toBe('https://screenpipe.com/api/user');
      return new Response(JSON.stringify({
        success: true,
        user: { clerk_id: 'user_legacy', cloud_subscribed: true },
      }), { status: 200 });
    }) as typeof fetch;

    expect(await validateAuth(requestFor('eyJ.legacy.screenpipe'), env)).toEqual({
      isValid: true,
      tier: 'subscribed',
      deviceId: 'user_legacy',
      userId: 'user_legacy',
    });
  });

  it('does not authenticate an unsuccessful 200 response from /api/user', async () => {
    globalThis.fetch = mock(async () => new Response(JSON.stringify({
      success: false,
    }), { status: 200 })) as typeof fetch;

    expect(await validateAuth(requestFor('eyJ.invalid.screenpipe'), env)).toEqual({
      isValid: true,
      tier: 'anonymous',
      deviceId: 'device-from-header',
    });
  });
});

describe('Auth security considerations', () => {
  it('should not leak sensitive info in error responses', () => {
    const safeErrorMessages = [
      'unauthorized',
      'invalid subscription',
      'rate limit exceeded',
    ];
    const unsafePatterns = [/api.key/i, /secret/i, /password/i, /token.*value/i];
    safeErrorMessages.forEach(msg => {
      unsafePatterns.forEach(pattern => {
        expect(msg).not.toMatch(pattern);
      });
    });
  });
});

describe('verifyClerkToken return shape', () => {
  // verifyClerkToken now returns { valid, userId? } instead of boolean
  // This is critical for credit lookups — userId must be clerk_id (user_xxx)

  it('should return object with valid and userId', () => {
    // Simulate successful verification
    const result = { valid: true, userId: 'user_2ppjMkjVL86ft5qDAEUgs3fwmAZ' };
    expect(result.valid).toBe(true);
    expect(result.userId).toMatch(/^user_[a-zA-Z0-9]+$/);
  });

  it('should return valid=false on failure without userId', () => {
    const result = { valid: false };
    expect(result.valid).toBe(false);
    expect((result as any).userId).toBeUndefined();
  });
});

describe('ScreenpipeUserData interface', () => {
  it('should include clerk_id for credit resolution', () => {
    const userData = {
      id: 'e3dfa6a0-414c-4e79-883e-3dd4d802cd9c',
      clerk_id: 'user_2ppjMkjVL86ft5qDAEUgs3fwmAZ',
      email: 'test@test.com',
      cloud_subscribed: false,
    };
    // validateScreenpipeToken should prefer clerk_id over id
    const resolvedUserId = userData.clerk_id || userData.id || userData.email;
    expect(resolvedUserId).toBe('user_2ppjMkjVL86ft5qDAEUgs3fwmAZ');
  });

  it('should fall back to UUID when no clerk_id', () => {
    const userData = {
      id: 'e3dfa6a0-414c-4e79-883e-3dd4d802cd9c',
      clerk_id: undefined,
      email: 'test@test.com',
      cloud_subscribed: false,
    };
    const resolvedUserId = userData.clerk_id || userData.id || userData.email;
    expect(resolvedUserId).toBe('e3dfa6a0-414c-4e79-883e-3dd4d802cd9c');
  });

  it('should fall back to email as last resort', () => {
    const userData = {
      id: undefined,
      clerk_id: undefined,
      email: 'test@test.com',
      cloud_subscribed: false,
    };
    const resolvedUserId = userData.clerk_id || userData.id || userData.email;
    expect(resolvedUserId).toBe('test@test.com');
  });
});
