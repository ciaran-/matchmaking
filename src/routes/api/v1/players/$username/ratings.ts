import { createFileRoute } from '@tanstack/react-router';
import { toErrorResponse } from '@/lib/api/errors';
import { apiMiddleware } from '@/lib/api/middleware';
import { jsonOk } from '@/lib/api/respond';
import { resolveApiUser } from '@/lib/auth';
import { getPlayerRatingHistory } from '@/lib/player-rating-history';

/**
 * `GET /api/v1/players/:username/ratings` — a player's rating after each
 * game they've played, oldest first.
 *
 * Same authorization stance as `GET /api/v1/players/:username`: any
 * authenticated caller may read any player's rating history. It carries
 * no more than the profile endpoint already exposes (rating over time vs.
 * rating now), so scoping it to the subject would hide nothing.
 *
 * Does not include the `DEFAULT_RATING` origin point before the first
 * game — see `getPlayerRatingHistory`. A player with no games returns an
 * empty array, not a 404; only an unknown username is a 404.
 */
export const Route = createFileRoute('/api/v1/players/$username/ratings')({
	server: {
		middleware: [apiMiddleware],
		handlers: {
			GET: async ({ request, params }) => {
				try {
					await resolveApiUser(request);

					const history = await getPlayerRatingHistory(params.username);
					if (!history) {
						throw new Error(`Player ${params.username} not found`);
					}

					return jsonOk(history);
				} catch (e) {
					return toErrorResponse(
						e,
						"Couldn't load that player's rating history.",
					);
				}
			},
		},
	},
});
