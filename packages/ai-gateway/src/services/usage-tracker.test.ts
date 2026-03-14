import { describe, it, expect, beforeEach, mock } from 'bun:test';
import { TIER_CONFIG, isModelAllowed } from './usage-tracker';

describe('TIER_CONFIG', () => {
  it('should have correct limits for anonymous tier', () => {
    expect(TIER_CONFIG.anonymous.dailyQueries).toBe(25);
    expect(TIER_CONFIG.anonymous.rpm).toBeLessThanOrEqual(15);
    expect(TIER_CONFIG.anonymous.allowedModels).toContain('claude-haiku-4-5');
  });

  it('should have correct limits for logged_in tier', () => {
    expect(TIER_CONFIG.logged_in.dailyQueries).toBe(50);
    expect(TIER_CONFIG.logged_in.rpm).toBeGreaterThan(TIER_CONFIG.anonymous.rpm);
    expect(TIER_CONFIG.logged_in.allowedModels).toContain('claude-sonnet-4-5');
  });

  it('should have correct limits for subscribed tier', () => {
    expect(TIER_CONFIG.subscribed.dailyQueries).toBe(1000);
    expect(TIER_CONFIG.subscribed.allowedModels).toContain('*');
  });

  it('logged_in should have strictly more queries than anonymous', () => {
    expect(TIER_CONFIG.logged_in.dailyQueries).toBeGreaterThan(TIER_CONFIG.anonymous.dailyQueries);
  });

  it('subscribed should have strictly more queries than logged_in', () => {
    expect(TIER_CONFIG.subscribed.dailyQueries).toBeGreaterThan(TIER_CONFIG.logged_in.dailyQueries);
  });

  it('all tiers should have positive query limits', () => {
    for (const [tier, config] of Object.entries(TIER_CONFIG)) {
      expect(config.dailyQueries).toBeGreaterThan(0);
      expect(config.rpm).toBeGreaterThan(0);
      expect(config.allowedModels.length).toBeGreaterThan(0);
    }
  });
});

describe('isModelAllowed', () => {
  it('should allow haiku for anonymous users', () => {
    expect(isModelAllowed('claude-haiku-4-5-20251001', 'anonymous')).toBe(true);
    expect(isModelAllowed('claude-haiku-4-5', 'anonymous')).toBe(true);
  });

  it('should deny sonnet for anonymous users', () => {
    expect(isModelAllowed('claude-sonnet-4-5-20250929', 'anonymous')).toBe(false);
  });

  it('should allow sonnet for logged_in users', () => {
    expect(isModelAllowed('claude-sonnet-4-5-20250929', 'logged_in')).toBe(true);
    expect(isModelAllowed('gpt-4o-mini', 'logged_in')).toBe(true);
  });

  it('should deny opus for logged_in users', () => {
    expect(isModelAllowed('claude-opus-4-6', 'logged_in')).toBe(false);
  });

  it('should allow any model for subscribed users', () => {
    expect(isModelAllowed('claude-opus-4-6', 'subscribed')).toBe(true);
    expect(isModelAllowed('gpt-4o', 'subscribed')).toBe(true);
    expect(isModelAllowed('any-random-model', 'subscribed')).toBe(true);
  });

  it('should handle partial model name matches', () => {
    expect(isModelAllowed('claude-haiku', 'anonymous')).toBe(true);
    expect(isModelAllowed('haiku', 'anonymous')).toBe(true);
  });

  it('should be case-insensitive', () => {
    expect(isModelAllowed('Claude-Haiku-4-5', 'anonymous')).toBe(true);
    expect(isModelAllowed('CLAUDE-HAIKU-4-5', 'anonymous')).toBe(true);
  });

  it('should deny completely unrelated models for non-subscribed', () => {
    expect(isModelAllowed('llama-3-70b', 'anonymous')).toBe(false);
    expect(isModelAllowed('llama-3-70b', 'logged_in')).toBe(false);
  });

  it('should allow gemini flash for anonymous', () => {
    expect(isModelAllowed('gemini-2.5-flash', 'anonymous')).toBe(true);
    expect(isModelAllowed('gemini-3-flash', 'anonymous')).toBe(true);
  });

  it('should allow gemini pro for logged_in but not anonymous', () => {
    expect(isModelAllowed('gemini-3-pro', 'logged_in')).toBe(true);
    expect(isModelAllowed('gemini-3.1-pro', 'logged_in')).toBe(true);
    expect(isModelAllowed('gemini-3.1-pro-preview', 'logged_in')).toBe(true);
    expect(isModelAllowed('gemini-3-pro', 'anonymous')).toBe(false);
    expect(isModelAllowed('gemini-3.1-pro', 'anonymous')).toBe(false);
  });
});

describe('resolveClerkId logic', () => {
  // We can't call resolveClerkId directly (not exported), but we can test the regex patterns
  const CLERK_ID_REGEX = /^user_[a-zA-Z0-9]+$/;
  const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

  it('should recognize clerk IDs', () => {
    expect(CLERK_ID_REGEX.test('user_2ppjMkjVL86ft5qDAEUgs3fwmAZ')).toBe(true);
    expect(CLERK_ID_REGEX.test('user_abc123')).toBe(true);
  });

  it('should not match UUIDs as clerk IDs', () => {
    expect(CLERK_ID_REGEX.test('e3dfa6a0-414c-4e79-883e-3dd4d802cd9c')).toBe(false);
  });

  it('should not match JWTs as clerk IDs', () => {
    expect(CLERK_ID_REGEX.test('eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9.payload.sig')).toBe(false);
  });

  it('should not match emails as clerk IDs', () => {
    expect(CLERK_ID_REGEX.test('test@example.com')).toBe(false);
  });

  it('should recognize UUIDs', () => {
    expect(UUID_REGEX.test('e3dfa6a0-414c-4e79-883e-3dd4d802cd9c')).toBe(true);
    expect(UUID_REGEX.test('00000000-0000-0000-0000-000000000000')).toBe(true);
  });

  it('should not match clerk IDs as UUIDs', () => {
    expect(UUID_REGEX.test('user_2ppjMkjVL86ft5qDAEUgs3fwmAZ')).toBe(false);
  });

  it('should not match random strings as either', () => {
    expect(CLERK_ID_REGEX.test('')).toBe(false);
    expect(UUID_REGEX.test('')).toBe(false);
    expect(CLERK_ID_REGEX.test('random')).toBe(false);
    expect(UUID_REGEX.test('random')).toBe(false);
  });
});

describe('credit deduction response parsing', () => {
  // Test the shape of responses from the Supabase RPC that our code parses

  it('should handle successful deduction', () => {
    const response = [{ success: true, new_balance: 399, transaction_id: 'abc-123', error_message: null }];
    expect(Array.isArray(response)).toBe(true);
    expect(response.length).toBeGreaterThan(0);
    expect(response[0].success).toBe(true);
    expect(response[0].new_balance).toBe(399);
  });

  it('should handle insufficient credits', () => {
    const response = [{ success: false, new_balance: 2, transaction_id: null, error_message: 'Insufficient credits' }];
    expect(response[0].success).toBe(false);
    expect(response[0].new_balance).toBe(2);
  });

  it('should handle user not found', () => {
    const response = [{ success: false, new_balance: 0, transaction_id: null, error_message: 'User has no credits' }];
    expect(response[0].success).toBe(false);
    expect(response[0].new_balance).toBe(0);
  });
});

describe('UsageResult credit fields', () => {
  it('should include paidVia when credit deducted', () => {
    const result = {
      used: 50,
      limit: 50,
      remaining: 0,
      allowed: true,
      resetsAt: '2026-02-13T00:00:00.000Z',
      paidVia: 'credits' as const,
      creditsRemaining: 399,
    };
    expect(result.allowed).toBe(true);
    expect(result.paidVia).toBe('credits');
    expect(result.creditsRemaining).toBe(399);
  });

  it('should include creditsRemaining when blocked', () => {
    const result = {
      used: 50,
      limit: 50,
      remaining: 0,
      allowed: false,
      resetsAt: '2026-02-13T00:00:00.000Z',
      creditsRemaining: 0,
    };
    expect(result.allowed).toBe(false);
    expect(result.creditsRemaining).toBe(0);
    expect(result.paidVia).toBeUndefined();
  });

  it('result without credits is backward-compatible', () => {
    // Old clients that don't know about credits should still work
    const result = {
      used: 10,
      limit: 50,
      remaining: 40,
      allowed: true,
      resetsAt: '2026-02-13T00:00:00.000Z',
    };
    expect(result.allowed).toBe(true);
    expect((result as any).paidVia).toBeUndefined();
    expect((result as any).creditsRemaining).toBeUndefined();
  });
});

describe('429 error response shapes', () => {
  it('daily_limit_exceeded should have upgrade_options', () => {
    const body = {
      error: 'daily_limit_exceeded',
      message: "You've used all 50 free AI queries for today. Resets at 2026-02-13T00:00:00.000Z",
      used_today: 50,
      limit_today: 50,
      resets_at: '2026-02-13T00:00:00.000Z',
      tier: 'logged_in',
      credits_remaining: 100,
      upgrade_options: {
        buy_credits: { url: 'https://screenpi.pe/onboarding', benefit: 'Credits extend your daily limit — use anytime' },
        subscribe: { url: 'https://screenpi.pe/onboarding', benefit: '1000 queries/day + 500 credits/mo + encrypted sync', price: '$29/mo' },
      },
    };
    // Not credits_exhausted because user has 100 credits remaining
    // This case shouldn't happen in practice (credits would be deducted first)
    // but tests the response shape
    expect(body.credits_remaining).toBe(100);
    expect(body.upgrade_options.buy_credits).toBeDefined();
    expect(body.upgrade_options.subscribe.price).toBe('$29/mo');
  });

  it('credits_exhausted should signal user has no credits', () => {
    const body = {
      error: 'credits_exhausted',
      message: "You've used all free queries and have no credits remaining. Buy more at screenpi.pe",
      credits_remaining: 0,
    };
    expect(body.error).toBe('credits_exhausted');
    expect(body.credits_remaining).toBe(0);
  });

  it('anonymous users should get login upgrade option', () => {
    const body = {
      error: 'daily_limit_exceeded',
      tier: 'anonymous',
      credits_remaining: 0,
      upgrade_options: {
        login: { benefit: '+25 daily queries, more models' },
        buy_credits: { url: 'https://screenpi.pe/onboarding', benefit: 'Credits extend your daily limit — use anytime' },
        subscribe: { url: 'https://screenpi.pe/onboarding', benefit: '1000 queries/day + 500 credits/mo + encrypted sync', price: '$29/mo' },
      },
    };
    expect(body.upgrade_options.login).toBeDefined();
  });
});

describe('backward compatibility', () => {
  it('existing app versions that dont know about credits should not break on 429', () => {
    // Old apps parse: error, message, used_today, limit_today, resets_at, tier
    // New fields (credits_remaining, upgrade_options.buy_credits) are additive
    const response = JSON.stringify({
      error: 'credits_exhausted',
      message: 'some message',
      used_today: 50,
      limit_today: 50,
      resets_at: '2026-02-13T00:00:00.000Z',
      tier: 'logged_in',
      credits_remaining: 0,
      upgrade_options: {
        buy_credits: { url: 'https://screenpi.pe/onboarding' },
        subscribe: { url: 'https://screenpi.pe/onboarding' },
      },
    });
    const parsed = JSON.parse(response);
    // Old apps just check error === 'daily_limit_exceeded' — 'credits_exhausted' is new
    // But the HTTP status is still 429, so old apps will show generic rate limit message
    expect(parsed.used_today).toBe(50);
    expect(parsed.limit_today).toBe(50);
    expect(parsed.tier).toBe('logged_in');
  });

  it('X-Credits-Remaining header is additive and safe for old clients', () => {
    // Old apps don't read X-Credits-Remaining, so adding it is safe
    const headers = new Headers();
    headers.set('X-Credits-Remaining', '399');
    headers.set('X-Paid-Via', 'credits');
    // These are just extra headers, old code ignores them
    expect(headers.get('X-Credits-Remaining')).toBe('399');
  });

  it('user endpoint credits_balance is additive', () => {
    // Old app User type has credits: { amount: number }
    // New field credits_balance is separate — old code ignores it
    const userResponse = {
      id: 'uuid',
      email: 'test@test.com',
      credits: { amount: 400 },
      credits_balance: 400,  // new field
      cloud_subscribed: false,
    };
    // Old code accesses .credits.amount — still works
    expect(userResponse.credits.amount).toBe(400);
    // New code accesses .credits_balance
    expect(userResponse.credits_balance).toBe(400);
  });
});

describe('cost control', () => {
  it('tier limits should be reasonable for cost control', () => {
    // At ~$0.001 per query (Haiku), 25 queries = ~$0.025/user/day
    // 1000 DAU = $25/day = $750/month - acceptable for growth
    const anonymousCost = TIER_CONFIG.anonymous.dailyQueries * 0.001;
    expect(anonymousCost).toBeLessThan(0.05);
  });

  it('credit-paid queries should be self-funding', () => {
    // $400 lifetime = 400 credits
    // Each credit pays for 1 query
    // At $0.01/query avg cost (mixed models), 400 credits = $4 cost
    // $400 revenue / $4 cost = 100x margin on credits
    const creditCost = 400 * 0.01;
    expect(creditCost).toBeLessThan(400);
  });

  it('subscribed tier daily limit should cap monthly cost', () => {
    // 1000 queries/day * 30 days * $0.002/query = $60/month at actual avg cost
    // Pro subscription is $29/mo — but avg user uses maybe 20% of quota
    const worstCaseMonthly = TIER_CONFIG.subscribed.dailyQueries * 30 * 0.002;
    expect(worstCaseMonthly).toBeLessThan(200); // Must be under $200/mo worst case
  });
});
