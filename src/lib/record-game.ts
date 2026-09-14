// Server-only module — do not import from client-side code.

import type { GameResult } from '@prisma/client';
import * as Sentry from '@sentry/tanstackstart-react';
import { prisma } from '@/db';
import { calculateElo1v1, type EloResult } from './elo';
import type { DbClient } from './matchmaking/state';

export interface RecordGameInput {
	playerAId: string; // User.id cuid
	playerBId: string; // User.id cuid
	result: EloResult; // 'A' | 'B' | 'draw'
}

export interface RecordGameOutput {
	gameResult: GameResult;
	ratingChangeA: number;
	ratingChangeB: number;
}

/**
 * Record a completed 1v1 game and apply the Elo change to both players.
 *
 * Pass `client` to run inside a caller's transaction — the match-to-result
 * conversion does this so that recording the game and marking the match
 * played commit together. Called without one, this opens its own
 * transaction, so existing callers keep the atomicity they always had.
 *
 * Both `User` rows are locked with `SELECT … FOR UPDATE` in id order
 * before their ratings are read, matching `proposePendingGame`. Without
 * the lock, two concurrent games involving the same player can read the
 * same `currentRating` and one update is lost.
 */
export async function recordGame(
	input: RecordGameInput,
	client?: DbClient,
): Promise<RecordGameOutput> {
	return Sentry.startSpan({ name: 'Record game result' }, async () => {
		const { playerAId, playerBId } = input;

		if (playerAId === playerBId) {
			throw new Error('playerAId and playerBId must be different');
		}

		if (client) return recordGameWith(client, input);
		return prisma.$transaction((tx) => recordGameWith(tx, input));
	});
}

async function recordGameWith(
	client: DbClient,
	input: RecordGameInput,
): Promise<RecordGameOutput> {
	const { playerAId, playerBId, result } = input;

	// Lock both rows in a deterministic order, so two conversions
	// crossing the same pair from opposite directions cannot deadlock.
	const [firstUserId, secondUserId] = [playerAId, playerBId].slice().sort();
	await client.$queryRaw`SELECT id FROM "User" WHERE id = ${firstUserId} FOR UPDATE`;
	await client.$queryRaw`SELECT id FROM "User" WHERE id = ${secondUserId} FOR UPDATE`;

	const users = await client.user.findMany({
		where: { id: { in: [playerAId, playerBId] } },
	});

	const userA = users.find((u) => u.id === playerAId);
	const userB = users.find((u) => u.id === playerBId);

	if (!userA || !userB) throw new Error('One or both players not found');

	const scores = { A: [1, 0], B: [0, 1], draw: [0, 0] } as const;
	const [teamAScore, teamBScore] = scores[result];

	const { changeA, changeB } = calculateElo1v1(
		userA.currentRating,
		userB.currentRating,
		result,
	);

	const ratingAfterA = userA.currentRating + changeA;
	const ratingAfterB = userB.currentRating + changeB;

	const gameResult = await client.gameResult.create({
		data: {
			mode: 'ONE_VS_ONE',
			teamAScore,
			teamBScore,
			participants: {
				create: [
					{
						userId: playerAId,
						team: 'A',
						ratingBefore: userA.currentRating,
						ratingAfter: ratingAfterA,
						ratingChange: changeA,
					},
					{
						userId: playerBId,
						team: 'B',
						ratingBefore: userB.currentRating,
						ratingAfter: ratingAfterB,
						ratingChange: changeB,
					},
				],
			},
		},
	});
	await client.user.update({
		where: { id: playerAId },
		data: { currentRating: ratingAfterA },
	});
	await client.user.update({
		where: { id: playerBId },
		data: { currentRating: ratingAfterB },
	});

	return { gameResult, ratingChangeA: changeA, ratingChangeB: changeB };
}
