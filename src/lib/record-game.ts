// Server-only module — do not import from client-side code.

import type { GameResult } from '@prisma/client';
import * as Sentry from '@sentry/tanstackstart-react';
import { prisma } from '@/db';
import { calculateElo1v1, type EloResult } from './elo';

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

export async function recordGame(
	input: RecordGameInput,
): Promise<RecordGameOutput> {
	return Sentry.startSpan({ name: 'Record game result' }, async () => {
		const { playerAId, playerBId, result } = input;

		if (playerAId === playerBId) {
			throw new Error('playerAId and playerBId must be different');
		}

		const users = await prisma.user.findMany({
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

		const [gameResult] = await prisma.$transaction([
			prisma.gameResult.create({
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
			}),
			prisma.user.update({
				where: { id: playerAId },
				data: { currentRating: ratingAfterA },
			}),
			prisma.user.update({
				where: { id: playerBId },
				data: { currentRating: ratingAfterB },
			}),
		]);

		return { gameResult, ratingChangeA: changeA, ratingChangeB: changeB };
	});
}
