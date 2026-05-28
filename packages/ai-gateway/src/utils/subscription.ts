import { Env } from '../types';

/**
 * Cache for subscription status to reduce API calls
 */
class SubscriptionCache {
  private cache: Map<string, { isValid: boolean; timestamp: number }>;
  private readonly CACHE_TTL = 5 * 60 * 1000; // 5 minutes in milliseconds

  constructor() {
    this.cache = new Map();
  }

  get(userId: string): boolean | null {
    const entry = this.cache.get(userId);
    if (!entry) return null;

    if (Date.now() - entry.timestamp > this.CACHE_TTL) {
      this.cache.delete(userId);
      return null;
    }

    return entry.isValid;
  }

  set(userId: string, isValid: boolean) {
    this.cache.set(userId, {
      isValid,
      timestamp: Date.now(),
    });
  }
}

export const subscriptionCache = new SubscriptionCache();

/**
 * Validates if a user has an active subscription
 * @param env Environment variables
 * @param userId User ID to validate (can be UUID or Clerk user ID)
 * @returns Promise resolving to boolean indicating if subscription is valid
 */
export async function validateSubscription(env: Env, userId: string): Promise<boolean> {
  console.log('validating user has cloud subscription');
  // Check cache first
  const cached = subscriptionCache.get(userId);
  if (cached !== null) {
    return cached;
  }

  const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  const CLERK_USER_ID_REGEX = /^user_[a-zA-Z0-9]+$/;

  // Check by UUID (Supabase user ID)
  if (UUID_REGEX.test(userId)) {
    try {
      const response = await fetch(`${env.SUPABASE_URL}/rest/v1/rpc/has_active_cloud_subscription`, {
        method: 'POST',
        headers: {
          apikey: env.SUPABASE_ANON_KEY,
          Authorization: `Bearer ${env.SUPABASE_ANON_KEY}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ input_user_id: userId }),
      });

      if (!response.ok) {
        console.error('Supabase error:', await response.text());
        return false;
      }

      const isValid: boolean = await response.json();
      subscriptionCache.set(userId, isValid);
      return isValid;
    } catch (error) {
      console.error('Error checking subscription:', error);
      return false;
    }
  }

  // Check by Clerk user ID - allow all signed-in Clerk users for Agent SDK
  // TODO: Add proper subscription checks for Clerk users
  if (CLERK_USER_ID_REGEX.test(userId)) {
    console.log('Allowing Clerk user ID for Agent SDK');
    subscriptionCache.set(userId, true);
    return true;
  }

  // Check for JWT token (from screenpipe desktop app) - validate against screenpipe API
  if (userId.startsWith('eyJ')) {
    try {
      const response = await fetch('https://screenpi.pe/api/user', {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${userId}`,
          'Content-Type': 'application/json',
        },
      });

      if (response.ok) {
        await response.json();
        console.log('Valid screenpipe user token');
        subscriptionCache.set(userId, true);
        return true;
      } else {
        console.log('Invalid screenpipe user token');
        subscriptionCache.set(userId, false);
        return false;
      }
    } catch (error) {
      console.error('Error validating screenpipe token:', error);
      return false;
    }
  }

  return false;
}
