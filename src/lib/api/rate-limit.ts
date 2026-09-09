// Server-only module — do not import from client-side code.

/**
 * Per-credential rate limiting for the REST API.
 *
 * ## Read this before trusting it
 *
 * The store is **in-process**, and the app runs on Netlify Functions. Each
 * lambda instance therefore keeps its own counters, so the effective limit
 * is `LIMIT × (number of live instances)`, and instances come and go with
 * traffic. This is a **courtesy limit that protects a single instance from
 * a runaway client — not a security control**, and it must not be relied
 * on to bound abuse.
 *
 * It is here because it is cheap, has no infrastructure dependency, and
 * makes the 429 contract real for clients to develop against. The actual
 * enforcement belongs at the edge (Netlify's own rate limiting) or in a
 * shared store, which is the documented follow-up. Deliberately *not*
 * reaching for a shared cache first: adding Redis for a limit we have no
 * measurements to size would be exactly the speculative infrastructure
 * this codebase avoids.
 *
 * The bucket logic below is pure and separately tested, so swapping
 * `InMemoryRateLimitStore` for a shared one changes one construction site
 * and nothing else.
 */

/** Requests permitted per window, per credential. */
export const RATE_LIMIT = 120;

/** Window length in milliseconds. */
export const RATE_LIMIT_WINDOW_MS = 60_000;

export type RateLimitDecision = {
	allowed: boolean;
	/** Requests left in the current window, floored at 0. */
	remaining: number;
	/** Whole seconds until the window resets. At least 1 when blocked. */
	retryAfterSeconds: number;
};

type Bucket = {
	count: number;
	/** Epoch ms at which this window ends. */
	resetAt: number;
};

export interface RateLimitStore {
	get(key: string): Bucket | undefined;
	set(key: string, bucket: Bucket): void;
}

/**
 * A `Map`-backed store. Entries are evicted lazily on read once their
 * window has passed, plus a bounded sweep on write so an instance that
 * sees many distinct credentials cannot grow without limit.
 */
export class InMemoryRateLimitStore implements RateLimitStore {
	private buckets = new Map<string, Bucket>();

	constructor(private readonly maxKeys = 10_000) {}

	get(key: string): Bucket | undefined {
		return this.buckets.get(key);
	}

	set(key: string, bucket: Bucket): void {
		if (this.buckets.size >= this.maxKeys) {
			this.evictExpired(bucket.resetAt);
			// Still full of live windows: drop the oldest-resetting entry
			// rather than let the map grow unbounded.
			if (this.buckets.size >= this.maxKeys) {
				const oldest = [...this.buckets.entries()].reduce((a, b) =>
					a[1].resetAt <= b[1].resetAt ? a : b,
				);
				this.buckets.delete(oldest[0]);
			}
		}
		this.buckets.set(key, bucket);
	}

	private evictExpired(now: number): void {
		for (const [key, bucket] of this.buckets) {
			if (bucket.resetAt <= now) this.buckets.delete(key);
		}
	}

	/** Test seam. */
	get size(): number {
		return this.buckets.size;
	}
}

/**
 * Record a request against `key` and decide whether it is allowed.
 *
 * A fixed window, not a sliding one: simpler to reason about, and its
 * worst case (a burst spanning a window boundary allowing up to 2×LIMIT)
 * is irrelevant given the per-instance caveat above.
 *
 * `now` is injected so the behaviour is testable without fake timers.
 */
export function consumeRateLimit(
	store: RateLimitStore,
	key: string,
	now: number = Date.now(),
): RateLimitDecision {
	const existing = store.get(key);

	if (!existing || existing.resetAt <= now) {
		const resetAt = now + RATE_LIMIT_WINDOW_MS;
		store.set(key, { count: 1, resetAt });
		return {
			allowed: true,
			remaining: RATE_LIMIT - 1,
			retryAfterSeconds: Math.ceil(RATE_LIMIT_WINDOW_MS / 1000),
		};
	}

	const count = existing.count + 1;
	store.set(key, { count, resetAt: existing.resetAt });

	const retryAfterSeconds = Math.max(
		1,
		Math.ceil((existing.resetAt - now) / 1000),
	);

	return {
		allowed: count <= RATE_LIMIT,
		remaining: Math.max(0, RATE_LIMIT - count),
		retryAfterSeconds,
	};
}

/**
 * Derive the bucket key for a request.
 *
 * Keyed on a **hash** of the credential, never the credential itself: the
 * raw value is a secret, and this string ends up in a long-lived map and
 * potentially in diagnostics. Hashing also means one PAT is limited as one
 * client whether or not it resolves to a user, so unauthenticated floods
 * from a single bad key are still bucketed.
 *
 * Requests with no credential all share the `anonymous` bucket. That is
 * deliberate: they cannot be told apart without trusting client-supplied
 * headers, and they are cheap to reject. Bounding *those* is the edge's
 * job, not ours.
 */
export async function rateLimitKey(request: Request): Promise<string> {
	const credential =
		request.headers.get('authorization') ?? request.headers.get('cookie');

	if (!credential) return 'anonymous';

	const digest = await crypto.subtle.digest(
		'SHA-256',
		new TextEncoder().encode(credential),
	);
	return [...new Uint8Array(digest)]
		.map((b) => b.toString(16).padStart(2, '0'))
		.join('')
		.slice(0, 32);
}
