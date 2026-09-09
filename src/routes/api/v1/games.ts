import { createFileRoute } from '@tanstack/react-router';
import { parseJsonBody } from '@/lib/api/body';
import { toErrorResponse } from '@/lib/api/errors';
import { apiMiddleware } from '@/lib/api/middleware';
import { jsonOk } from '@/lib/api/respond';
import { recordGameBody } from '@/lib/api/schemas';
import { resolveApiUser } from '@/lib/auth';
import { canActOnGame } from '@/lib/authorization';
import { recordGame } from '@/lib/record-game';

/**
 * `POST /api/v1/games` — record a game result.
 *
 * The first write path in the API (Checkpoint 3), wrapping `recordGame`
 * exactly as `recordGameFn` (`src/routes/league.tsx`) does today. Follows
 * the leaderboard reference implementation's shape: authenticate with
 * either credential, validate at the edge, delegate to the `src/lib/`
 * core, serialise through `respond.ts`, map throws through the standard
 * error envelope.
 *
 * **Authorization policy is unresolved** (see the plan / T8 report): any
 * signed-in user may record a game for any two players, matching
 * `recordGameFn`'s current behaviour. This is kept for parity, not a
 * deliberate endorsement — see the final task report for the
 * recommendation.
 */
export const Route = createFileRoute('/api/v1/games')({
	server: {
		middleware: [apiMiddleware],
		handlers: {
			POST: async ({ request }) => {
				try {
					const user = await resolveApiUser(request);

					const body = await parseJsonBody(request, recordGameBody);
					if (!body.ok) return body.response;

					// You may only record a game you played in; admins may
					// record anyone's.
					if (!canActOnGame(user, body.data)) {
						throw new Error('You are not a participant in this match');
					}

					const output = await recordGame(body.data);
					return jsonOk(output, 201);
				} catch (e) {
					return toErrorResponse(e, "Couldn't record the game.");
				}
			},
		},
	},
});
