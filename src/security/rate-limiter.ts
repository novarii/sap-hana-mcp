/**
 * Simple sliding-window rate limiter.
 * Prevents runaway LLM loops from hammering prod HANA.
 */

export class RateLimiter {
  private timestamps: number[] = [];
  private readonly maxRequests: number;
  private readonly windowMs: number;

  constructor(maxRequests: number = 30, windowMs: number = 60_000) {
    this.maxRequests = maxRequests;
    this.windowMs = windowMs;
  }

  check(): void {
    const now = Date.now();
    // Prune old entries
    this.timestamps = this.timestamps.filter((t) => now - t < this.windowMs);

    if (this.timestamps.length >= this.maxRequests) {
      throw new Error(
        `Rate limit exceeded: max ${this.maxRequests} queries per ${this.windowMs / 1000}s. ` +
        `Try again in a few seconds.`
      );
    }

    this.timestamps.push(now);
  }
}

// Singleton — shared across all tool calls
export const queryRateLimiter = new RateLimiter();
