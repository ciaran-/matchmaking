import { createFileRoute } from '@tanstack/react-router';
import { toErrorResponse } from '@/lib/api/errors';
import { apiMiddleware } from '@/lib/api/middleware';
import { jsonOk } from '@/lib/api/respond';
import { resolveApiUser } from '@/lib/auth';
import { getPlayerProfile } from '@/lib/player-profile';

/**
 * `GET /api/v1/players/:username` — a player's identity, record and rank.
 *
 * Any authenticated caller may read any profile. That is not an oversight:
 * usernames, ratings and records are already public on the leaderboard, so
 * scoping this to the subject would hide nothing. It is deliberately
 * different from `/matches/:matchId`, which *is* participant-scoped —
 * a match reveals who played whom, which the leaderboard does not.
 */
export const Route = createFileRoute('/api/v1/players/$username')({
	server: {
		middleware: [apiMiddleware],
		handlers: {
			GET: async ({ request, params }) => {
				try {
					await resolveApiUser(request);

					const profile = await getPlayerProfile(params.username);
					if (!profile) {
						throw new Error(`Player ${params.username} not found`);
					}

					return jsonOk(profile);
				} catch (e) {
					return toErrorResponse(e, "Couldn't load that profile.");
				}
			},
		},
	},
});
