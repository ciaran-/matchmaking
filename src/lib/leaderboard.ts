// Server-only module — do not import from client-side code.

import { prisma } from '@/db';

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
	gamesPlayed: number;
};

/**
 * The league table, highest rating first.
 *
 * Win/loss is derived from the sign of each participation's
 * `ratingChange` — the same rule the league page applies inline. A draw
 * moves the rating by zero, so it counts as neither.
 *
 * Rank is positional: tied ratings get distinct, arbitrary ranks rather
 * than a shared one. That matches what the league page renders today.
 *
 * Feature 10 (leaderboard hardening) is expected to replace this with a
 * paginated, tie-aware query and to fold in the league page's inline
 * derivation, removing the duplication that exists between the two while
 * both live.
 */
export async function getLeaderboard(): Promise<LeaderboardEntry[]> {
	const users = await prisma.user.findMany({
		orderBy: { currentRating: 'desc' },
		include: { gameParticipations: true },
	});

	return users.map((user, index) => ({
		rank: index + 1,
		id: user.id,
		username: user.username,
		currentRating: user.currentRating,
		wins: user.gameParticipations.filter((g) => g.ratingChange > 0).length,
		losses: user.gameParticipations.filter((g) => g.ratingChange < 0).length,
		gamesPlayed: user.gameParticipations.length,
	}));
}
