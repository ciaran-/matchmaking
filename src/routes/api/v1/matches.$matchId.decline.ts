import { createFileRoute } from '@tanstack/react-router';
import { z } from 'zod';
import { toErrorResponse } from '@/lib/api/errors';
import { jsonError, jsonOk } from '@/lib/api/respond';
import { serializeMatchState } from '@/lib/api/serialize';
import { resolveApiUser } from '@/lib/auth';
import { declinePendingGame } from '@/lib/matchmaking/pending-game';

const paramsSchema = z.object({ matchId: z.string().uuid() });

/**
 * `POST /api/v1/matches/:matchId/decline` — mirrors `declineMatchFn` in
 * `src/routes/match.tsx`. Per plan decision #7, declining writes
 * `DECLINED` events for the match and for both source searches — neither
 * player remains queued. That's `declinePendingGame`'s behaviour, not
 * reimplemented here.
 *
 * Cross-user guard: `declinePendingGame` throws `"... user is not a
 * participant in this match"` for a non-participant, mapped to 403 by
 * `toErrorResponse` (see `src/lib/api/errors.ts`).
 */
export const Route = createFileRoute('/api/v1/matches/$matchId/decline')({
	server: {
		handlers: {
			POST: async ({ request, params }) => {
				try {
					const parsedParams = paramsSchema.safeParse(params);
					if (!parsedParams.success) {
						return jsonError('bad_request', 'Invalid match id.', 400);
					}

					const dbUser = await resolveApiUser(request);
					const match = await declinePendingGame(
						parsedParams.data.matchId,
						dbUser.id,
					);
					return jsonOk(serializeMatchState(match));
				} catch (e) {
					return toErrorResponse(e, "Couldn't decline the match.");
				}
			},
		},
	},
});
