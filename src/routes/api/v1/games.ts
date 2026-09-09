import { createFileRoute } from '@tanstack/react-router';
import { z } from 'zod';
import { toErrorResponse } from '@/lib/api/errors';
import { jsonError, jsonOk } from '@/lib/api/respond';
import { resolveApiUser } from '@/lib/auth';
import { recordGame } from '@/lib/record-game';

/**
 * Body schema for `POST /api/v1/games`, mirroring `RecordGameInput`
 * (`src/lib/record-game.ts`). Parsed at the edge with `safeParse` so the
 * handler receives typed, validated input — the lib core is not
 * re-validated. Per the conventions doc §5, a parse failure returns a
 * generic `bad_request`/400 message; zod's `issues` array is never
 * serialised into the response.
 */
const recordGameBody = z.object({
	playerAId: z.string(),
	playerBId: z.string(),
	result: z.enum(['A', 'B', 'draw']),
});

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
		handlers: {
			POST: async ({ request }) => {
				try {
					await resolveApiUser(request);

					const parsed = recordGameBody.safeParse(await request.json());
					if (!parsed.success) {
						return jsonError('bad_request', 'Invalid request body.', 400);
					}

					const output = await recordGame(parsed.data);
					return jsonOk(output, 201);
				} catch (e) {
					return toErrorResponse(e, "Couldn't record the game.");
				}
			},
		},
	},
});
