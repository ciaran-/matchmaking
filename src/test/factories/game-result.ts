import type {
	GameMode,
	GameParticipant,
	GameResult,
	PrismaClient,
} from '@prisma/client';

interface ParticipantSpec {
	userId: string;
	team: 'A' | 'B';
	ratingBefore: number;
	ratingAfter: number;
	ratingChange: number;
}

interface GameResultOverrides {
	mode?: GameMode;
	teamAScore?: number;
	teamBScore?: number;
	participants?: ParticipantSpec[];
	createdAt?: Date;
}

export async function createGameResult(
	prisma: PrismaClient,
	overrides: GameResultOverrides = {},
): Promise<GameResult & { participants: GameParticipant[] }> {
	return prisma.gameResult.create({
		data: {
			mode: overrides.mode ?? 'ONE_VS_ONE',
			teamAScore: overrides.teamAScore ?? 1,
			teamBScore: overrides.teamBScore ?? 0,
			...(overrides.createdAt !== undefined
				? { createdAt: overrides.createdAt }
				: {}),
			participants: overrides.participants
				? { create: overrides.participants }
				: { create: [] },
		},
		include: { participants: true },
	});
}
