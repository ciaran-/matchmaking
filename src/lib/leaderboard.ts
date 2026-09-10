// Server-only module — do not import from client-side code.

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

/**
 * Rank every entry in an already rating-ordered list.
 *
 * Standard competition ranking: players level on rating share the better
 * rank and the next player skips (1, 2, 2, 4). Matches `getPlayerProfile`,
 * which counts strictly-higher-rated players — the two must agree, or a
 * player's profile and their leaderboard row would claim different
 * positions.
 */
function withRanks<T extends { currentRating: number }>(
	ordered: T[],
): Array<T & { rank: number }> {
	// Carries the previous *rank* rather than deriving from the index, so a
	// tie of three or more all share one rank. Reading the index directly
	// only survives ties of exactly two.
	return ordered.reduce<Array<T & { rank: number }>>((ranked, entry, index) => {
		const previous = ranked[ranked.length - 1];
		// Pushing rather than spreading: rebuilding the accumulator each
		// step would make ranking the table O(n²).
		ranked.push({
			...entry,
			rank:
				previous && previous.currentRating === entry.currentRating
					? previous.rank
					: index + 1,
		});
		return ranked;
	}, []);
}

/**
 * The league table, highest rating first.
 *
 * Outcomes are counted in the database via `countOutcomes` — see
 * `game-outcome.ts` for why they are read from the recorded score rather
 * than from `ratingChange`, and what the old rule got wrong.
 *
 * Feature 10 (leaderboard hardening) is expected to add pagination and
 * search on top of this. Until then it returns every player, which is fine
 * at current scale and will not be at ten thousand.
 */
export async function getLeaderboard(
	client: DbClient = prisma,
): Promise<LeaderboardEntry[]> {
	const users = await client.user.findMany({
		orderBy: { currentRating: 'desc' },
		select: { id: true, username: true, currentRating: true },
	});

	const counts = await countOutcomes(
		users.map((user) => user.id),
		client,
	);

	return withRanks(users).map((user) => ({
		...user,
		...(counts.get(user.id) ?? NO_GAMES),
	}));
}
