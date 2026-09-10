// Server-only module — do not import from client-side code.

import * as Sentry from '@sentry/tanstackstart-react';
import { prisma } from '@/db';
import type { DbClient } from '@/lib/matchmaking/state';

export interface RatingHistoryPoint {
	rating: number;
	/** ISO timestamp — the game's `GameResult.createdAt`. */
	at: string;
	gameResultId: string;
}

/**
 * A player's rating after each game they've played, oldest first.
 *
 * Returns `null` for an unknown username so the caller decides how
 * absence is presented — a 404 for the API, a not-found state for the
 * page — mirroring `getPlayerProfile`. A known player with no games
 * returns `[]`, distinct from `null`.
 *
 * Deliberately does **not** include the `DEFAULT_RATING` origin point
 * before the first game — that's a presentation concern (see
 * `RatingChart`), so a caller that only wants real game snapshots isn't
 * forced to filter out a synthetic row.
 *
 * X-axis note: this returns real timestamps, not evenly-spaced indices.
 * The chart currently plots by game index (even spacing) rather than by
 * `at`, but every point keeps its timestamp so the axis can change later
 * without a backend change.
 */
export async function getPlayerRatingHistory(
	username: string,
	client: DbClient = prisma,
): Promise<RatingHistoryPoint[] | null> {
	return Sentry.startSpan({ name: 'Get player rating history' }, async () => {
		const user = await client.user.findUnique({
			where: { username },
			select: { id: true },
		});

		if (!user) return null;

		const rows = await client.gameParticipant.findMany({
			where: { userId: user.id },
			select: {
				ratingAfter: true,
				gameResultId: true,
				gameResult: { select: { createdAt: true } },
			},
			orderBy: { gameResult: { createdAt: 'asc' } },
		});

		return rows.map((row) => ({
			rating: row.ratingAfter,
			at: row.gameResult.createdAt.toISOString(),
			gameResultId: row.gameResultId,
		}));
	});
}
