import { createFileRoute } from '@tanstack/react-router';
import { toErrorResponse } from '@/lib/api/errors';
import { jsonOk } from '@/lib/api/respond';
import { resolveApiUser } from '@/lib/auth';
import { getMatchState } from '@/lib/matchmaking/state';

/**
 * `GET /api/v1/matches/:matchId` — the derived state of a single match
 * proposal. 404 when no `PROPOSED` event exists for the id (unknown or
 * never-created match).
 *
 * `confirmedBy` comes back from `getMatchState` as a `Set<string>`,
 * which `JSON.stringify` (and so `Response.json`/`jsonOk`) serialises
 * as `{}` — silently dropping its contents. Translating it to an array
 * here is wire serialisation, not business logic, so it belongs in this
 * adapter rather than in `src/lib/matchmaking/state.ts`.
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
					return jsonOk({ ...match, confirmedBy: [...match.confirmedBy] });
				} catch (e) {
					return toErrorResponse(e, "Couldn't load that match.");
				}
			},
		},
	},
});
