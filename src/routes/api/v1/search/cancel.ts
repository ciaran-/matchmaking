import { createFileRoute } from '@tanstack/react-router';
import { toErrorResponse } from '@/lib/api/errors';
import { apiMiddleware } from '@/lib/api/middleware';
import { jsonOk } from '@/lib/api/respond';
import { resolveApiUser } from '@/lib/auth';
import { cancelSearch } from '@/lib/matchmaking/search';

/**
 * `POST /api/v1/search/cancel` — mirrors `cancelSearchFn` in
 * `src/routes/match.tsx`. `cancelSearch` always acts on the resolved
 * caller's own active attempt (`dbUser.id`), so there's no id in this
 * request that could belong to someone else to guard against.
 *
 * `cancelSearch` throws when the caller has no active search (already
 * terminal, or never started) — mapped to 409 by `toErrorResponse` (see
 * `src/lib/api/errors.ts`, the rule added alongside this endpoint).
 */
export const Route = createFileRoute('/api/v1/search/cancel')({
	server: {
		middleware: [apiMiddleware],
		handlers: {
			POST: async ({ request }) => {
				try {
					const dbUser = await resolveApiUser(request);
					const search = await cancelSearch(dbUser.id);
					return jsonOk(search);
				} catch (e) {
					return toErrorResponse(e, "Couldn't cancel the search.");
				}
			},
		},
	},
});
