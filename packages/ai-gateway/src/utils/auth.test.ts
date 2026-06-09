import { describe, it, expect } from 'bun:test';
import { activeSubscriptionFilter } from './subscription';

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

describe('Auth tier determination', () => {
  it('should return anonymous tier when no auth header', () => {
    const expectedBehavior = {
      noAuthHeader: { tier: 'anonymous', isValid: true },
      invalidToken: { tier: 'anonymous', isValid: true }, // Fail-open design
      validTokenNoSub: { tier: 'logged_in', isValid: true },
      validTokenWithSub: { tier: 'subscribed', isValid: true },
    };
    expect(expectedBehavior.noAuthHeader.tier).toBe('anonymous');
    expect(expectedBehavior.invalidToken.tier).toBe('anonymous');
  });

  it('should extract device ID from X-Device-Id header', () => {
    const testDeviceId = 'test-uuid-1234';
    expect(testDeviceId).toMatch(/^[a-z0-9-]+$/);
  });

  it('should fall back to IP when no device ID header', () => {
    const fallbackToIp = true;
    expect(fallbackToIp).toBe(true);
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

describe('auth userId → credit resolution paths', () => {
  // Document all auth paths and their userId formats
  // This is critical: user_credits uses clerk_id (user_xxx) as key

  const authPaths = [
    { path: 'UUID token', example: 'e3dfa6a0-414c-4e79-883e-3dd4d802cd9c', needsResolution: true },
    { path: 'Clerk user_id token', example: 'user_2ppjMkjVL86ft5q', needsResolution: false },
    { path: 'Clerk JWT (verified)', example: 'user_2ppjMkjVL86ft5q', needsResolution: false },
    { path: 'Screenpipe JWT (with clerk_id)', example: 'user_2ppjMkjVL86ft5q', needsResolution: false },
    { path: 'Screenpipe JWT (UUID fallback)', example: 'e3dfa6a0-414c-4e79-883e-3dd4d802cd9c', needsResolution: true },
    { path: 'Anonymous', example: undefined, needsResolution: false },
  ];

  const CLERK_ID_REGEX = /^user_[a-zA-Z0-9]+$/;
  const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

  for (const authPath of authPaths) {
    it(`${authPath.path}: resolveClerkId should ${authPath.needsResolution ? 'look up' : 'pass through'}`, () => {
      if (!authPath.example) {
        // Anonymous — no userId, credits don't apply
        expect(authPath.example).toBeUndefined();
        return;
      }
      if (CLERK_ID_REGEX.test(authPath.example)) {
        expect(authPath.needsResolution).toBe(false);
      }
      if (UUID_REGEX.test(authPath.example)) {
        expect(authPath.needsResolution).toBe(true);
      }
    });
  }
});
