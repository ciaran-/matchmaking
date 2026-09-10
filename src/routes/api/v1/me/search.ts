import { createFileRoute } from '@tanstack/react-router';
import { toErrorResponse } from '@/lib/api/errors';
import { apiMiddleware } from '@/lib/api/middleware';
import { jsonOk } from '@/lib/api/respond';
import { resolveApiUser } from '@/lib/auth';
import { getActiveSearchForUser } from '@/lib/matchmaking/state';

/**
 * `GET /api/v1/me/search` — the calling user's active matchmaking
 * search, or `null` if they have none (no active attempt is a normal
 * outcome, not an error — mirrors `getActiveSearchForUser` itself and
 * the `search: null` shape `pollSearchStatusFn` already returns to the
 * web app).
 *
 * Scoped to the caller: `resolveApiUser` resolves the credential to a
 * `User`, and that user's own id is the only id ever queried — there is
 * no way to pass another user's id in.
 */
export const Route = createFileRoute('/api/v1/me/search')({
	server: {
		middleware: [apiMiddleware],
		handlers: {
			GET: async ({ request }) => {
				try {
					const user = await resolveApiUser(request);
					return jsonOk(await getActiveSearchForUser(user.id));
				} catch (e) {
					return toErrorResponse(e, "Couldn't load your search status.");
				}
			},
		},
	},
});
