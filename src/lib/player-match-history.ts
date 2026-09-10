// Server-only module — do not import from client-side code.

import type { GameMode } from '@prisma/client';
import * as Sentry from '@sentry/tanstackstart-react';
import { prisma } from '@/db';
import { type GameOutcome, outcomeFor } from '@/lib/game-outcome';
import type { DbClient } from '@/lib/matchmaking/state';

export interface MatchHistoryRow {
	gameResultId: string;
	opponentUsername: string;
	outcome: GameOutcome;
	ratingChange: number;
	ratingAfter: number;
	/** ISO timestamp — the game's `createdAt`. */
	playedAt: string;
	mode: GameMode;
}

export interface MatchHistoryPage {
	data: MatchHistoryRow[];
	nextCursor: string | null;
}

export interface MatchHistoryOptions {
	cursor?: string;
	limit?: number;
}

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 50;

/**
 * Opaque pagination cursor, keyed on `(GameResult.createdAt, GameResult.id)`.
 *
 * `createdAt` alone is not a stable sort key: the seed data and fast test
 * writes both produce games sharing a millisecond timestamp, so the id is
 * a tiebreaker, not a nicety. Encoded as base64url so it round-trips
 * safely through a query string.
 */
function encodeCursor(row: { createdAt: Date; gameResultId: string }): string {
	return Buffer.from(
		`${row.createdAt.toISOString()}|${row.gameResultId}`,
		'utf8',
	).toString('base64url');
}

function decodeCursor(
	token: string,
): { createdAt: Date; gameResultId: string } | null {
	try {
		const decoded = Buffer.from(token, 'base64url').toString('utf8');
		const [iso, gameResultId] = decoded.split('|');
		if (!iso || !gameResultId) return null;
		const createdAt = new Date(iso);
		if (Number.isNaN(createdAt.getTime())) return null;
		return { createdAt, gameResultId };
	} catch {
		return null;
	}
}

/**
 * A page of a player's completed match history, newest first: opponent,
 * outcome, rating movement and when it happened.
 *
 * Returns `null` for an unknown username, mirroring `getPlayerProfile`'s
 * contract so callers (the API route) can 404 the same way.
 *
 * **1v1 only.** `TEAM_VS_TEAM` games are filtered out of the result set
 * entirely rather than guessing an "opponent" from a multi-player roster —
 * opponent resolution and the win/loss/draw perspective are only
 * well-defined for two participants. Team matchmaking doesn't exist yet,
 * so this is a defensible v1 scope, not a missing feature; revisit when
 * it does.
 *
 * Outcome is classified via `outcomeFor` (`src/lib/game-outcome.ts`) from
 * the recorded score, never from the sign of `ratingChange` — see that
 * module for why the naive rule misclassifies a draw between unequally
 * rated players.
 *
 * @param opts.cursor - An opaque token from a previous page's
 * `nextCursor`. Throws `Error('Invalid cursor')` if it doesn't decode —
 * the route maps that to `bad_request`/400.
 * @param opts.limit - Page size, clamped to `[1, 50]`; defaults to 20.
 */
export async function getPlayerMatchHistory(
	username: string,
	opts: MatchHistoryOptions = {},
	client: DbClient = prisma,
): Promise<MatchHistoryPage | null> {
	return Sentry.startSpan({ name: 'Get player match history' }, async () => {
		const user = await client.user.findUnique({
			where: { username },
			select: { id: true },
		});
		if (!user) return null;

		const limit = Math.min(Math.max(opts.limit ?? DEFAULT_LIMIT, 1), MAX_LIMIT);

		let cursor: { createdAt: Date; gameResultId: string } | null = null;
		if (opts.cursor) {
			cursor = decodeCursor(opts.cursor);
			if (!cursor) throw new Error('Invalid cursor');
		}

		// Driven from GameResult, not GameParticipant: the cursor and sort
		// order are both keyed on GameResult's own columns, and `mode` +
		// `createdAt` are covered by its existing `@@index([mode, createdAt])`.
		const games = await client.gameResult.findMany({
			where: {
				mode: 'ONE_VS_ONE',
				participants: { some: { userId: user.id } },
				...(cursor
					? {
							OR: [
								{ createdAt: { lt: cursor.createdAt } },
								{
									createdAt: cursor.createdAt,
									id: { lt: cursor.gameResultId },
								},
							],
						}
					: {}),
			},
			select: {
				id: true,
				createdAt: true,
				mode: true,
				teamAScore: true,
				teamBScore: true,
				participants: {
					select: {
						userId: true,
						team: true,
						ratingChange: true,
						ratingAfter: true,
						user: { select: { username: true } },
					},
				},
			},
			orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
			take: limit + 1,
		});

		const page = games.slice(0, limit);
		const hasMore = games.length > limit;

		const rows: MatchHistoryRow[] = page.flatMap((game) => {
			const me = game.participants.find((p) => p.userId === user.id);
			const opponent = game.participants.find((p) => p.userId !== user.id);
			// Defensive: a ONE_VS_ONE game should always have exactly this
			// player plus one opponent. A row failing that is a data
			// integrity problem, not something to guess an opponent for —
			// skip it rather than invent one.
			if (!me || !opponent) return [];

			return [
				{
					gameResultId: game.id,
					opponentUsername: opponent.user.username,
					outcome: outcomeFor(me.team, game.teamAScore, game.teamBScore),
					ratingChange: me.ratingChange,
					ratingAfter: me.ratingAfter,
					playedAt: game.createdAt.toISOString(),
					mode: game.mode,
				},
			];
		});

		const last = page.at(-1);
		const nextCursor =
			hasMore && last
				? encodeCursor({ createdAt: last.createdAt, gameResultId: last.id })
				: null;

		return { data: rows, nextCursor };
	});
}
