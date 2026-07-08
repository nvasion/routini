/**
 * A tiny sliding-window rate limiter used to slow brute-force attempts against
 * the login endpoint. Intentionally in-memory — the horizon for this feature
 * is a single process; if the server is scaled out the operator should front
 * it with an authenticating proxy that has its own rate limiter (e.g. nginx
 * limit_req, an API gateway, or a Redis-backed limiter).
 *
 * Keeping the implementation local keeps the dependency graph small and, more
 * importantly, keeps the security-critical logic auditable in one file.
 */

export interface RateLimiterOptions {
  /** Maximum attempts allowed in the window. */
  maxAttempts: number
  /** Window length in seconds. */
  windowSeconds: number
  /** Optional clock override for tests. */
  now?: () => number
  /**
   * Guardrail against unbounded memory growth from unique attacker-controlled
   * keys. Once exceeded, the oldest keys are evicted.
   */
  maxKeys?: number
}

export interface RateLimitDecision {
  allowed: boolean
  /** Seconds until the next attempt is allowed. Zero when `allowed` is true. */
  retryAfterSeconds: number
}

const DEFAULT_MAX_KEYS = 10_000

export class RateLimiter {
  private readonly buckets = new Map<string, number[]>()
  private readonly maxAttempts: number
  private readonly windowMs: number
  private readonly now: () => number
  private readonly maxKeys: number

  constructor(options: RateLimiterOptions) {
    if (!Number.isInteger(options.maxAttempts) || options.maxAttempts <= 0) {
      throw new Error('maxAttempts must be a positive integer')
    }
    if (!Number.isInteger(options.windowSeconds) || options.windowSeconds <= 0) {
      throw new Error('windowSeconds must be a positive integer')
    }
    this.maxAttempts = options.maxAttempts
    this.windowMs = options.windowSeconds * 1000
    this.now = options.now ?? Date.now
    this.maxKeys = options.maxKeys ?? DEFAULT_MAX_KEYS
  }

  /**
   * Records an attempt for `key` and reports whether it should be allowed.
   *
   * ### Sliding window algorithm
   *
   * Each key maps to a chronological array of attempt timestamps. On every
   * `hit()` we:
   *
   * 1. Compute `windowStart = now - windowMs` (the trailing edge of the
   *    window).
   * 2. Drop timestamps older than `windowStart` — those attempts no longer
   *    count against the caller. This is what makes the limit "slide" with
   *    time instead of using discrete fixed buckets (which would allow a
   *    burst of `2*maxAttempts` at the boundary).
   * 3. If the remaining count is `>= maxAttempts`, deny and compute the
   *    minimum retry delay as `(oldest + windowMs) - now` — i.e. how long
   *    until the head of the window slides forward enough to free a slot.
   * 4. Otherwise, append `now`, save, and allow.
   *
   * The trade-off vs. a token-bucket implementation is memory: each key
   * stores up to `maxAttempts` timestamps. With `maxAttempts=10` and small
   * `maxKeys`, the footprint is negligible; the LRU eviction below guards
   * against an attacker forcing per-key allocations.
   */
  hit(key: string): RateLimitDecision {
    if (typeof key !== 'string' || key.length === 0) {
      // A missing key means we can't rate limit — fail open rather than
      // globally rejecting, but note the call is a bug.
      return { allowed: true, retryAfterSeconds: 0 }
    }
    const now = this.now()
    const windowStart = now - this.windowMs
    const timestamps = this.buckets.get(key) ?? []
    // Drop entries older than the window (step 2 above).
    const fresh = timestamps.filter((ts) => ts > windowStart)
    if (fresh.length >= this.maxAttempts) {
      // Save the pruned list even on rejection so future calls have accurate
      // state without redoing the prune.
      this.buckets.set(key, fresh)
      const oldest = fresh[0]
      const retryAfterSeconds = Math.max(
        1,
        Math.ceil((oldest + this.windowMs - now) / 1000),
      )
      return { allowed: false, retryAfterSeconds }
    }
    fresh.push(now)
    this.buckets.set(key, fresh)
    this.evictIfNeeded()
    return { allowed: true, retryAfterSeconds: 0 }
  }

  /** Clear a key's history — call on successful login to reset counters. */
  reset(key: string): void {
    if (typeof key === 'string' && key.length > 0) {
      this.buckets.delete(key)
    }
  }

  /** Test/introspection helper. */
  size(): number {
    return this.buckets.size
  }

  private evictIfNeeded(): void {
    if (this.buckets.size <= this.maxKeys) return
    // Map iteration order is insertion order — evict from the front.
    const overflow = this.buckets.size - this.maxKeys
    let removed = 0
    for (const key of this.buckets.keys()) {
      this.buckets.delete(key)
      removed += 1
      if (removed >= overflow) break
    }
  }
}

/**
 * Derive a stable client identifier from an Express-style request. We prefer
 * `req.ip` (Express resolves this from trust-proxy settings), falling back
 * to the raw socket address. Anonymous callers collapse to a fixed key so
 * they still share a bucket rather than escaping rate limiting entirely.
 */
export function clientIpFromRequest(req: {
  ip?: string | null
  socket?: { remoteAddress?: string | null } | null
}): string {
  const ip = req.ip
  if (typeof ip === 'string' && ip.length > 0) return ip
  const remote = req.socket?.remoteAddress
  if (typeof remote === 'string' && remote.length > 0) return remote
  return 'unknown'
}
