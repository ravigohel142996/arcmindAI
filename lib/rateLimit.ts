import { Ratelimit, type Algorithm } from "@upstash/ratelimit";
import { Redis } from "@upstash/redis";

// DEV: Skip Redis construction when env vars are absent to prevent crashes
// during local development. A no-op limiter is used instead that always allows.
const isRedisConfigured = !!(
  process.env.UPSTASH_REDIS_REST_URL?.trim() &&
  process.env.UPSTASH_REDIS_REST_TOKEN?.trim()
);

// Minimal interface used by all callers (only `.limit()` is needed).
type RateLimiter = {
  limit: (identifier: string) => Promise<{
    success: boolean;
    limit: number;
    remaining: number;
    reset: number;
    pending: Promise<unknown>;
  }>;
};

// DEV: Mock rate limiter — always allows when Redis is not configured.
function createDevRateLimiter(): RateLimiter {
  return {
    limit: async () => ({
      success: true,
      limit: 9999,
      remaining: 9999,
      reset: Date.now() + 60_000,
      pending: Promise.resolve(),
    }),
  };
}

const redis = isRedisConfigured
  ? new Redis({
      url: process.env.UPSTASH_REDIS_REST_URL!,
      token: process.env.UPSTASH_REDIS_REST_TOKEN!,
    })
  : null;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function createRateLimiter(limiter: Algorithm<any>): RateLimiter {
  if (!redis) {
    // DEV: Redis not configured — return no-op limiter
    return createDevRateLimiter();
  }
  return new Ratelimit({ redis, limiter, analytics: true });
}

// 2 requests per 2 minutes
export const generationRateLimit = createRateLimiter(Ratelimit.slidingWindow(2, "120 s"));

// 1 OTP per minute
export const otpRateLimit = createRateLimiter(Ratelimit.slidingWindow(1, "60 s"));

// 5 login attempts per IP per minute
export const loginRateLimitIP = createRateLimiter(Ratelimit.slidingWindow(5, "60 s"));

// 5 login attempts per account per hour
export const loginRateLimitAccount = createRateLimiter(Ratelimit.slidingWindow(5, "3600 s"));
