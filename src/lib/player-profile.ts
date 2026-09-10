// Server-only module — do not import from client-side code.

import * as Sentry from '@sentry/tanstackstart-react';
import { prisma } from '@/db';
import { countOutcomes, NO_GAMES } from '@/lib/game-outcome';
import type { DbClient } from '@/lib/matchmaking/state';

export interface PlayerProfile {
	id: string;
	username: string;
	currentRating: number;
	/** ISO timestamp — the row's `createdAt`. */
	memberSince: string;
	/** 1-based. See the tie note on `rankFor`. */
	rank: number;
	wins: number;
	losses: number;
	draws: number;
	gamesPlayed: number;
}

/**
 * A player's identity, headline record and league position.
 *
 * Returns `null` for an unknown username so the caller decides how absence
 * is presented — a 404 for the API, a not-found state for the page.
 *
 * Win/loss/draw come from `countOutcomes`, which is the one definition
 * shared with the leaderboard; see `game-outcome.ts` for why the outcome
 * is read from the score rather than from `ratingChange`.
 */
export async function getPlayerProfile(
	username: string,
	client: DbClient = prisma,
): Promise<PlayerProfile | null> {
	return Sentry.startSpan({ name: 'Get player profile' }, async () => {
		const user = await client.user.findUnique({
			where: { username },
			select: {
				id: true,
				username: true,
				currentRating: true,
				createdAt: true,
			},
		});

		if (!user) return null;

		// Both are scoped to this one user and neither depends on the
		// other, so they overlap rather than run back to back.
		const [counts, higherRated] = await Promise.all([
			countOutcomes([user.id], client),
			client.user.count({
				where: { currentRating: { gt: user.currentRating } },
			}),
		]);

		return {
			id: user.id,
			username: user.username,
			currentRating: user.currentRating,
			memberSince: user.createdAt.toISOString(),
			// Ties share the better rank: two players level on rating are
			// both "2nd" rather than arbitrarily ordered, and the next
			// player down is 4th. Standard competition ranking.
			rank: higherRated + 1,
			...(counts.get(user.id) ?? NO_GAMES),
		};
	});
}
