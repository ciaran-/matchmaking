// Server-only module — do not import from client-side code.

import * as Sentry from '@sentry/tanstackstart-react';
import { createMiddleware } from '@tanstack/react-start';
import {
	consumeRateLimit,
	InMemoryRateLimitStore,
	rateLimitKey,
} from '@/lib/api/rate-limit';
import { jsonError } from '@/lib/api/respond';

/**
 * Cross-cutting concerns for every `/api/v1/*` route: rate limiting and a
 * Sentry span.
 *
 * Attached per route via `server: { middleware: [apiMiddleware] }` rather
 * than wrapped around each handler by hand, so a new endpoint gets both by
 * declaring one array entry and cannot silently opt out of the limiter by
 * forgetting a wrapper.
 */

/**
 * One store per process. See `rate-limit.ts` for why per-process is a
 * courtesy limit rather than real enforcement.
 */
const store = new InMemoryRateLimitStore();

export const apiMiddleware = createMiddleware({ type: 'request' }).server(
	async ({ request, pathname, next }) => {
		const key = await rateLimitKey(request);
		const decision = consumeRateLimit(store, key);

		if (!decision.allowed) {
			const response = jsonError(
				'rate_limited',
				'Too many requests. Please slow down.',
				429,
			);
			// Retry-After is the whole point of a 429 — without it a client
			// can only guess, and guessing badly is what got it here.
			response.headers.set('Retry-After', String(decision.retryAfterSeconds));
			return response;
		}

		// Named by route pattern, not by resolved URL: `/api/v1/matches/m_123`
		// as its own span name would shatter the grouping into one span per
		// match id and make the endpoint's latency unreadable.
		return Sentry.startSpan(
			{ name: `API ${pathname}`, op: 'http.server' },
			async () => next(),
		);
	},
);
