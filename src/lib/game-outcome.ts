// Server-only module — do not import from client-side code.

import type { Team } from '@prisma/client';
import { Prisma } from '@prisma/client';
import { prisma } from '@/db';
import type { DbClient } from '@/lib/matchmaking/state';

/**
 * The single definition of what counts as a win, a loss and a draw.
 *
 * Everything that displays a record — the profile (feature 7), match
 * history (feature 8), the leaderboard (feature 10) — classifies through
 * here, so they cannot disagree.
 *
 * ## Why not `ratingChange`
 *
 * `/league` and the first cut of `src/lib/leaderboard.ts` inferred the
 * outcome from the sign of `ratingChange`: positive is a win, negative a
 * loss, zero a draw. **That is wrong**, and it was live on both the league
 * page and `GET /api/v1/leaderboard`.
 *
 * Elo moves both players on a draw unless their ratings were exactly
 * equal — the favourite loses points and the underdog gains them:
 *
 * ```
 * draw 1000 vs 1000 → changeA   0, changeB   0
 * draw 1200 vs 1000 → changeA  -8, changeB  +8
 * draw 1400 vs 1000 → changeA -13, changeB +13
 * ```
 *
 * So the old rule counted a draw as a **win** for the underdog and a
 * **loss** for the favourite, and only recognised a draw when the two
 * players happened to be level. Rating change is a *consequence* of the
 * result, not the result.
 *
 * The recorded outcome is the score. `recordGame` writes
 * `{ A: [1,0], B: [0,1], draw: [0,0] }`, so comparing the two team scores
 * against the participant's team is unambiguous and stays correct if the
 * K-factor or rating algorithm ever changes.
 */
export type GameOutcome = 'win' | 'loss' | 'draw';

/** Classify one participation. */
export function outcomeFor(
	team: Team,
	teamAScore: number,
	teamBScore: number,
): GameOutcome {
	if (teamAScore === teamBScore) return 'draw';
	const teamAWon = teamAScore > teamBScore;
	return (team === 'A') === teamAWon ? 'win' : 'loss';
}

export type OutcomeCounts = {
	wins: number;
	losses: number;
	draws: number;
	gamesPlayed: number;
};

export const NO_GAMES: OutcomeCounts = {
	wins: 0,
	losses: 0,
	draws: 0,
	gamesPlayed: 0,
};

/**
 * Count outcomes for the given users, **in the database**.
 *
 * Deliberately not "load every participation and count in JS", which is
 * what `/league` does today: that ships every row of every player's
 * history to compute four integers, and gets slower with every game ever
 * played. This returns one row per user regardless of history size.
 *
 * Users with no games are absent from the result — callers fall back to
 * `NO_GAMES` rather than this function inventing empty rows for ids that
 * may not exist.
 */
export async function countOutcomes(
	userIds: string[],
	client: DbClient = prisma,
): Promise<Map<string, OutcomeCounts>> {
	if (userIds.length === 0) return new Map();

	// `team` is an enum; cast to text so the comparison does not depend on
	// the generated enum type's name.
	const rows = await client.$queryRaw<
		Array<{
			userId: string;
			wins: number;
			losses: number;
			draws: number;
			gamesPlayed: number;
		}>
	>`
		SELECT
			p."userId" AS "userId",
			COUNT(*)::int AS "gamesPlayed",
			COUNT(*) FILTER (
				WHERE (p."team"::text = 'A' AND g."teamAScore" > g."teamBScore")
				   OR (p."team"::text = 'B' AND g."teamBScore" > g."teamAScore")
			)::int AS "wins",
			COUNT(*) FILTER (
				WHERE (p."team"::text = 'A' AND g."teamAScore" < g."teamBScore")
				   OR (p."team"::text = 'B' AND g."teamBScore" < g."teamAScore")
			)::int AS "losses",
			COUNT(*) FILTER (WHERE g."teamAScore" = g."teamBScore")::int AS "draws"
		FROM "GameParticipant" p
		JOIN "GameResult" g ON g."id" = p."gameResultId"
		WHERE p."userId" IN (${Prisma.join(userIds)})
		GROUP BY p."userId"
	`;

	return new Map(
		rows.map((row) => [
			row.userId,
			{
				wins: row.wins,
				losses: row.losses,
				draws: row.draws,
				gamesPlayed: row.gamesPlayed,
			},
		]),
	);
}
