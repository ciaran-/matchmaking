// Server-only module — do not import from client-side code.

import * as Sentry from '@sentry/tanstackstart-react';
import { createMiddleware } from '@tanstack/react-start';
import {
	consumeRateLimit,
	InMemoryRateLimitStore,
	rateLimitKey,
} from '@/lib/api/rate-limit';
import { jsonError } from '@/lib/api/respond';
import { resolveActor } from '@/lib/auth';

/**
 * Cross-cutting concerns for every `/api/v1/*` route: authentication,
 * rate limiting and a Sentry span.
 *
 * Attached per route via `server: { middleware: [apiMiddleware] }` rather
 * than wrapped around each handler by hand, so a new endpoint gets all
 * three by declaring one array entry.
 *
 * ## Authentication is default-deny
 *
 * Every handler already called `resolveApiUser` itself, but that was
 * *opt-in* — the same arrangement that left two server functions
 * unauthenticated, because a missing check reads exactly like a
 * deliberately public endpoint. Enforcing it here means a new route that
 * forgets is refused rather than open, and "public" becomes a one-line
 * entry in `PUBLIC_API_PATHS` that someone defends in review.
 *
 * Handlers keep calling `resolveApiUser` — they need the resolved user,
 * not just the guarantee that one exists. `resolveActor` memoizes per
 * request, so that second call costs nothing.
 */

/**
 * API paths callable without a credential.
 *
 * **Adding to this list makes an endpoint world-readable.**
 */
const PUBLIC_API_PATHS: ReadonlySet<string> = new Set([
	// A spec describes the shape of the API, not its data. Requiring a
	// credential to discover how to obtain a credential is a poor first
	// experience, and the document reveals nothing an authenticated
	// caller could not read anyway.
	'/api/v1/openapi.json',
]);

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

		if (!PUBLIC_API_PATHS.has(pathname)) {
			try {
				await resolveActor(request);
			} catch {
				return jsonError(
					'unauthorized',
					'Missing or invalid credentials.',
					401,
				);
			}
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
