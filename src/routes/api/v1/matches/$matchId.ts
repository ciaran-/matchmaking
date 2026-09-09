import { createFileRoute } from '@tanstack/react-router';
import { toErrorResponse } from '@/lib/api/errors';
import { jsonOk } from '@/lib/api/respond';
import { serializeMatchState } from '@/lib/api/serialize';
import { resolveApiUser } from '@/lib/auth';
import { getMatchState } from '@/lib/matchmaking/state';

/**
 * `GET /api/v1/matches/:matchId` — the derived state of a single match
 * proposal. 404 when no `PROPOSED` event exists for the id (unknown or
 * never-created match).
 *
 * Serialised via `serializeMatchState` — see that helper for why
 * `confirmedBy` cannot go to the wire as-is.
 */
export const Route = createFileRoute('/api/v1/matches/$matchId')({
	server: {
		handlers: {
			GET: async ({ request, params }) => {
				try {
					await resolveApiUser(request);
					const match = await getMatchState(params.matchId);
					if (!match) {
						throw new Error(`Match ${params.matchId} not found`);
					}
					return jsonOk(serializeMatchState(match));
				} catch (e) {
					return toErrorResponse(e, "Couldn't load that match.");
				}
			},
		},
	},
});
