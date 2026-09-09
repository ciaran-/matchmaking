import { createFileRoute } from '@tanstack/react-router';
import { z } from 'zod';
import { toErrorResponse } from '@/lib/api/errors';
import { jsonError, jsonOk } from '@/lib/api/respond';
import { serializeMatchState } from '@/lib/api/serialize';
import { resolveApiUser } from '@/lib/auth';
import { confirmPendingGame } from '@/lib/matchmaking/pending-game';

const paramsSchema = z.object({ matchId: z.string().uuid() });

/**
 * `POST /api/v1/matches/:matchId/confirm` — mirrors `confirmMatchFn` in
 * `src/routes/match.tsx`.
 *
 * Cross-user guard: `confirmPendingGame` throws `"... user is not a
 * participant in this match"` for a caller who is neither `playerAId`
 * nor `playerBId`, which `toErrorResponse` maps to 403 (see
 * `src/lib/api/errors.ts`'s `not a participant` rule). That check lives
 * in the lib, not here — this route only validates the id shape and
 * delegates.
 */
export const Route = createFileRoute('/api/v1/matches/$matchId/confirm')({
	server: {
		handlers: {
			POST: async ({ request, params }) => {
				try {
					const parsedParams = paramsSchema.safeParse(params);
					if (!parsedParams.success) {
						return jsonError('bad_request', 'Invalid match id.', 400);
					}

					const dbUser = await resolveApiUser(request);
					const match = await confirmPendingGame(
						parsedParams.data.matchId,
						dbUser.id,
					);
					return jsonOk(serializeMatchState(match));
				} catch (e) {
					return toErrorResponse(e, "Couldn't confirm the match.");
				}
			},
		},
	},
});
