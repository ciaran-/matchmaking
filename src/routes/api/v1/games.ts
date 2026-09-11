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
 * Wraps `recordGame` exactly as `recordGameFn` (`src/routes/league.tsx`)
 * does. Follows the leaderboard reference implementation's shape:
 * authenticate with either credential, validate at the edge, delegate to
 * the `src/lib/` core, serialise through `respond.ts`, map throws through
 * the standard error envelope.
 *
 * **Authorization:** you may record a game you played in; an `ADMIN` may
 * record anyone's (`canActOnGame`, the same check `recordGameFn` makes —
 * see `docs/decisions/0006-participant-scoped-authorization.md`). The
 * participant check runs before `recordGame` looks the players up, so a
 * non-participant gets 403 even when a player id does not exist. Keep that
 * order: reversing it would let this endpoint reveal which ids are real.
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
