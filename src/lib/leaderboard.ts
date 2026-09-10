// Server-only module — do not import from client-side code.

import { Prisma } from '@prisma/client';
import { prisma } from '@/db';
import { countOutcomes, NO_GAMES } from '@/lib/game-outcome';
import type { DbClient } from '@/lib/matchmaking/state';

/**
 * One row of the league table, already derived and free of anything
 * identifying beyond the username players choose to be known by — no
 * email, no Clerk id. Safe to serialise straight to an API client.
 */
export type LeaderboardEntry = {
	rank: number;
	id: string;
	username: string;
	currentRating: number;
	wins: number;
	losses: number;
	draws: number;
	gamesPlayed: number;
};

export type LeaderboardPage = {
	data: LeaderboardEntry[];
	page: number;
	pageSize: number;
	/** Rows matching the search, across all pages. Drives page controls. */
	total: number;
};

export type LeaderboardOptions = {
	/** 1-based. An out-of-range page returns empty `data`, not an error. */
	page?: number;
	pageSize?: number;
	/** Case-insensitive substring match on username. */
	search?: string;
};

export const DEFAULT_PAGE_SIZE = 25;
const MAX_PAGE_SIZE = 100;

/**
 * The league table, highest rating first.
 *
 * ## Rank is global, and the database computes it
 *
 * `RANK() OVER (ORDER BY currentRating DESC)` gives standard competition
 * ranking (1, 2, 2, 4) directly, matching `getPlayerProfile`, which counts
 * strictly-higher-rated players. The two must agree — a profile and a
 * leaderboard row claiming different positions for the same player would
 * be an obvious bug, and it is the kind that survives review because each
 * looks right on its own.
 *
 * Two things this deliberately avoids:
 *
 * - **Rank is not `offset + index + 1`.** That looks correct until a tie
 *   spans a page boundary, at which point ranks duplicate or skip
 *   depending which side of the split you are reading.
 * - **Rank is computed before the search filter.** Searching for a player
 *   should report their position *in the league*, not their position among
 *   the other people whose names happen to contain "an".
 *
 * Outcomes are counted separately by `countOutcomes` — see
 * `game-outcome.ts` for why they come from the recorded score rather than
 * from `ratingChange`.
 */
export async function getLeaderboard(
	options: LeaderboardOptions = {},
	client: DbClient = prisma,
): Promise<LeaderboardPage> {
	const page = Math.max(1, Math.floor(options.page ?? 1));
	const pageSize = Math.min(
		MAX_PAGE_SIZE,
		Math.max(1, Math.floor(options.pageSize ?? DEFAULT_PAGE_SIZE)),
	);
	const search = options.search?.trim() ?? '';
	const offset = (page - 1) * pageSize;

	// `%` and `_` are LIKE wildcards. Someone searching for "a_b" means
	// those characters literally, not "a, any character, b".
	const pattern = search
		? `%${search.replace(/[\\%_]/g, (character) => `\\${character}`)}%`
		: null;

	const matching = pattern
		? Prisma.sql`u."username" ILIKE ${pattern}`
		: Prisma.sql`TRUE`;

	const [rows, totals] = await Promise.all([
		client.$queryRaw<
			Array<{
				id: string;
				username: string;
				currentRating: number;
				rank: number;
			}>
		>`
			WITH ranked AS (
				SELECT
					u."id",
					u."username",
					u."currentRating",
					RANK() OVER (ORDER BY u."currentRating" DESC)::int AS "rank",
					${matching} AS "matches"
				FROM "User" u
			)
			SELECT r."id", r."username", r."currentRating", r."rank"
			FROM ranked r
			WHERE r."matches"
			ORDER BY r."rank" ASC, r."username" ASC
			LIMIT ${pageSize} OFFSET ${offset}
		`,
		client.$queryRaw<Array<{ total: number }>>`
			SELECT COUNT(*)::int AS "total" FROM "User" u WHERE ${matching}
		`,
	]);

	const counts = await countOutcomes(
		rows.map((row) => row.id),
		client,
	);

	return {
		data: rows.map((row) => ({
			rank: row.rank,
			id: row.id,
			username: row.username,
			currentRating: row.currentRating,
			...(counts.get(row.id) ?? NO_GAMES),
		})),
		page,
		pageSize,
		total: totals[0]?.total ?? 0,
	};
}

/**
 * A single player's league rank, for "jump to my rank".
 *
 * Same definition as `getPlayerProfile`'s rank: one more than the number
 * of players rated strictly higher.
 */
export async function getPlayerRank(
	userId: string,
	client: DbClient = prisma,
): Promise<number | null> {
	const user = await client.user.findUnique({
		where: { id: userId },
		select: { currentRating: true },
	});

	if (!user) return null;

	const higherRated = await client.user.count({
		where: { currentRating: { gt: user.currentRating } },
	});

	return higherRated + 1;
}

/** The 1-based page a given rank falls on. */
export function pageForRank(
	rank: number,
	pageSize: number = DEFAULT_PAGE_SIZE,
): number {
	return Math.max(1, Math.ceil(rank / pageSize));
}
