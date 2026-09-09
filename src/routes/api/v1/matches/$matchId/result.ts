import { createFileRoute } from '@tanstack/react-router';
import { prisma } from '@/db';
import { parseJsonBody } from '@/lib/api/body';
import { toErrorResponse } from '@/lib/api/errors';
import { apiMiddleware } from '@/lib/api/middleware';
import { jsonError, jsonOk } from '@/lib/api/respond';
import {
	matchResultBody as bodySchema,
	matchIdParams as paramsSchema,
} from '@/lib/api/schemas';
import { serializeMatchState } from '@/lib/api/serialize';
import { resolveApiUser } from '@/lib/auth';
import type { EloResult } from '@/lib/elo';
import { convertPendingGameToResult } from '@/lib/matchmaking/pending-game';
import { getMatchState } from '@/lib/matchmaking/state';

/**
 * `POST /api/v1/matches/:matchId/result` — mirrors
 * `recordPendingGameResultFn` in `src/routes/match.tsx`, including its
 * wire format: `result` is expressed from the **reporter's** perspective
 * (`'A'` = "I, the caller, won"; `'B'` = "the opponent won"), not from
 * `playerAId`/`playerBId`. `convertPendingGameToResult` interprets its
 * `result` argument from the match's perspective, so this handler flips
 * `'A' <-> 'B'` when the caller is the match's `playerBId` — exactly the
 * translation the server fn does. This is wire-format shaping, not
 * business logic, so it lives in the adapter; it isn't extracted into
 * `src/lib/` here to keep this checkpoint's change scoped to the API
 * surface.
 *
 * Deliberately does **not** duplicate `convertPendingGameToResult`'s own
 * not-found / not-a-participant checks — those already throw errors that
 * `toErrorResponse` maps to 404 / 403 (see `src/lib/api/errors.ts`). The
 * `getMatchState` read here exists only to learn `playerAId` for the
 * flip; if it comes back null the flip is skipped and the lib call fails
 * with its own (correctly-mapped) error.
 *
 * Success returns 201: like `POST /api/v1/games`, this creates a new
 * `GameResult`. `convertPendingGameToResult` (via `recordGame`) returns
 * the `GameResult` row without its participants — the web app's poll
 * endpoint re-reads it with `include: { participants: true }` to render
 * rating changes (see `pollSearchStatusFn` / `search.ts`'s GET handler),
 * and an API client posting a result deserves that same completeness
 * without a follow-up poll, so this handler does the same re-read.
 */
export const Route = createFileRoute('/api/v1/matches/$matchId/result')({
	server: {
		middleware: [apiMiddleware],
		handlers: {
			POST: async ({ request, params }) => {
				try {
					const parsedParams = paramsSchema.safeParse(params);
					if (!parsedParams.success) {
						return jsonError('bad_request', 'Invalid match id.', 400);
					}

					const body = await parseJsonBody(
						request,
						bodySchema,
						'Body must be { result: "A" | "B" | "draw" }.',
					);
					if (!body.ok) return body.response;

					const dbUser = await resolveApiUser(request);
					const { matchId } = parsedParams.data;
					const reported = body.data.result as EloResult;

					const matchState = await getMatchState(matchId);
					const matchPerspectiveResult: EloResult =
						!matchState || dbUser.id === matchState.playerAId
							? reported
							: reported === 'A'
								? 'B'
								: reported === 'B'
									? 'A'
									: 'draw';

					const { gameResult, matchState: finalMatch } =
						await convertPendingGameToResult(
							matchId,
							dbUser.id,
							matchPerspectiveResult,
						);
					const gameResultWithParticipants = await prisma.gameResult.findUnique(
						{
							where: { id: gameResult.id },
							include: { participants: true },
						},
					);

					return jsonOk(
						{
							gameResult: gameResultWithParticipants ?? gameResult,
							match: serializeMatchState(finalMatch),
						},
						201,
					);
				} catch (e) {
					return toErrorResponse(e, "Couldn't record the result.");
				}
			},
		},
	},
});
