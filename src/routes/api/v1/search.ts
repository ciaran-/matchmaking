import type { GameParticipant, GameResult } from '@prisma/client';
import { createFileRoute } from '@tanstack/react-router';
import { prisma } from '@/db';
import { toErrorResponse } from '@/lib/api/errors';
import { jsonOk } from '@/lib/api/respond';
import { serializeMatchState } from '@/lib/api/serialize';
import { resolveApiUser } from '@/lib/auth';
import { expireIfStale } from '@/lib/matchmaking/pending-game';
import { runMatcherForSearch } from '@/lib/matchmaking/run-matcher';
import { createSearch } from '@/lib/matchmaking/search';
import { getActiveSearchForUser, getMatchState } from '@/lib/matchmaking/state';

/** `GameResult` with its participants eagerly loaded — see `match.tsx`. */
type GameResultWithParticipants = GameResult & {
	participants: GameParticipant[];
};

/**
 * `POST /api/v1/search` (enter the queue) and `GET /api/v1/search` (poll)
 * — the matchmaking lifecycle's entry and status points.
 *
 * Mirrors `startSearchFn` and `pollSearchStatusFn` in `src/routes/match.tsx`
 * exactly: same lib calls, same hot-path matcher on start, same inline
 * `expireIfStale` on poll. No new realtime behaviour — this is the same
 * poll-based model the web app uses, exposed honestly.
 *
 * Both handlers act only on the resolved caller's own `userId` — there is
 * no id in this URL that could belong to someone else, so unlike the
 * `/matches/:matchId/...` endpoints there's no separate cross-user check
 * to make here.
 */
export const Route = createFileRoute('/api/v1/search')({
	server: {
		handlers: {
			POST: async ({ request }) => {
				try {
					const dbUser = await resolveApiUser(request);

					const search = await createSearch(dbUser.id);
					await runMatcherForSearch(search.attemptId);
					// Re-read so the caller sees the post-matcher state (STARTED or
					// MATCHED), same as startSearchFn.
					return jsonOk(await getActiveSearchForUser(dbUser.id));
				} catch (e) {
					return toErrorResponse(e, "Couldn't start a search.");
				}
			},
			GET: async ({ request }) => {
				try {
					const dbUser = await resolveApiUser(request);

					let search = await getActiveSearchForUser(dbUser.id);

					// Find the user's most recent match regardless of search state —
					// this is what lets the result still surface once the search has
					// gone CONSUMED (search becomes null at that point).
					const latestMatchedEvent =
						await prisma.matchmakingSearchEvent.findFirst({
							where: { userId: dbUser.id, matchId: { not: null } },
							orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
							select: { matchId: true },
						})
					const matchId = latestMatchedEvent?.matchId ?? null;

					// Inline expiry only when the user is currently MATCHED — same
					// condition pollSearchStatusFn uses; the periodic Netlify tick is
					// the backstop for matches with no live polling player.
					if (search?.status === 'MATCHED' && matchId) {
						await expireIfStale(matchId);
						search = await getActiveSearchForUser(dbUser.id);
					}

					const match = matchId ? await getMatchState(matchId) : null;

					let opponent: {
						id: string
						username: string
						currentRating: number;
					} | null = null;
					let gameResult: GameResultWithParticipants | null = null;

					if (match) {
						const opponentId =
							match.playerAId === dbUser.id ? match.playerBId : match.playerAId;
						opponent = await prisma.user.findUnique({
							where: { id: opponentId },
							select: { id: true, username: true, currentRating: true },
						})

						if (match.gameResultId) {
							gameResult = await prisma.gameResult.findUnique({
								where: { id: match.gameResultId },
								include: { participants: true },
							})
						}
					}

					return jsonOk({
						dbUserId: dbUser.id,
						search,
						match: match ? serializeMatchState(match) : null,
						opponent,
						gameResult,
					})
				} catch (e) {
					return toErrorResponse(e, "Couldn't load matchmaking status.");
				}
			},
		},
	},
});
