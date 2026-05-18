import type {
	MatchmakingSearchEvent,
	PrismaClient,
	User,
} from '@prisma/client';
import { createStartedSearch } from './factories/matchmaking-events';
import { createUser } from './factories/user';

/**
 * Two players both at rating 1000. The canonical baseline for testing
 * symmetric Elo outcomes.
 */
export async function twoEqualRatedPlayers(
	prisma: PrismaClient,
): Promise<[User, User]> {
	const playerA = await createUser(prisma, { currentRating: 1000 });
	const playerB = await createUser(prisma, { currentRating: 1000 });
	return [playerA, playerB];
}

/**
 * Two players at explicitly specified ratings. Use when the test is about
 * how Elo handles an imbalance (e.g. an upset, a dominant favourite).
 */
export async function twoUnequalRatedPlayers(
	prisma: PrismaClient,
	ratingA: number,
	ratingB: number,
): Promise<[User, User]> {
	const playerA = await createUser(prisma, { currentRating: ratingA });
	const playerB = await createUser(prisma, { currentRating: ratingB });
	return [playerA, playerB];
}

/**
 * Two equal-rated players, each with an active STARTED search. The
 * canonical baseline for matchmaking tests that need a pairable pair.
 */
export async function twoSearchingPlayersAtEqualRating(
	prisma: PrismaClient,
): Promise<{
	playerA: User;
	playerB: User;
	searchA: { attemptId: string; event: MatchmakingSearchEvent };
	searchB: { attemptId: string; event: MatchmakingSearchEvent };
}> {
	const [playerA, playerB] = await twoEqualRatedPlayers(prisma);
	const searchA = await createStartedSearch(prisma, playerA);
	const searchB = await createStartedSearch(prisma, playerB);
	return { playerA, playerB, searchA, searchB };
}
