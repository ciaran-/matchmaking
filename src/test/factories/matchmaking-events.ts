import { randomUUID } from 'node:crypto';
import type {
	MatchmakingSearchEvent,
	MatchmakingSearchEventType,
	PendingGameEvent,
	PendingGameEventType,
	PrismaClient,
	User,
} from '@prisma/client';

export interface CreateStartedSearchOptions {
	/** Override the rating snapshot. Defaults to `user.currentRating`. */
	rating?: number;
	/** Backdate the event for "old search" scenarios. */
	createdAt?: Date;
}

/**
 * Append a fresh STARTED event for the given user. Generates a new
 * `attemptId` and defaults the rating snapshot to `user.currentRating`.
 */
export async function createStartedSearch(
	prisma: PrismaClient,
	user: User,
	overrides: CreateStartedSearchOptions = {},
): Promise<{ attemptId: string; event: MatchmakingSearchEvent }> {
	const attemptId = randomUUID();
	const event = await prisma.matchmakingSearchEvent.create({
		data: {
			attemptId,
			userId: user.id,
			type: 'STARTED',
			rating: overrides.rating ?? user.currentRating,
			...(overrides.createdAt !== undefined
				? { createdAt: overrides.createdAt }
				: {}),
		},
	});
	return { attemptId, event };
}

export interface AppendSearchEventOptions {
	userId?: string;
	matchId?: string;
	createdAt?: Date;
}

/**
 * Append an arbitrary event to an existing search attempt.
 *
 * For STARTED events the `userId` override is required, since the test
 * is setting up an attempt from scratch rather than continuing one.
 */
export async function appendSearchEvent(
	prisma: PrismaClient,
	attemptId: string,
	type: MatchmakingSearchEventType,
	overrides: AppendSearchEventOptions = {},
): Promise<MatchmakingSearchEvent> {
	if (type === 'STARTED' && !overrides.userId) {
		throw new Error(
			'appendSearchEvent: userId override is required for STARTED events',
		);
	}

	const resolvedUserId =
		overrides.userId ??
		(await (async () => {
			const prior = await prisma.matchmakingSearchEvent.findFirst({
				where: { attemptId },
				orderBy: { createdAt: 'asc' },
			});
			if (!prior) {
				throw new Error(
					`appendSearchEvent: no prior events for attemptId=${attemptId} and no userId override given`,
				);
			}
			return prior.userId;
		})());

	return prisma.matchmakingSearchEvent.create({
		data: {
			attemptId,
			userId: resolvedUserId,
			type,
			...(overrides.matchId !== undefined
				? { matchId: overrides.matchId }
				: {}),
			...(overrides.createdAt !== undefined
				? { createdAt: overrides.createdAt }
				: {}),
		},
	});
}

export interface AppendMatchEventOptions {
	playerAId?: string;
	playerBId?: string;
	playerARating?: number;
	playerBRating?: number;
	searchAAttemptId?: string;
	searchBAttemptId?: string;
	actingPlayerId?: string;
	gameResultId?: string;
	createdAt?: Date;
}

/**
 * Append an arbitrary event to a pending match.
 *
 * For PROPOSED events both `playerAId` and `playerBId` overrides are
 * required — without them there is no valid proposal to record.
 */
export async function appendMatchEvent(
	prisma: PrismaClient,
	matchId: string,
	type: PendingGameEventType,
	overrides: AppendMatchEventOptions = {},
): Promise<PendingGameEvent> {
	if (type === 'PROPOSED' && (!overrides.playerAId || !overrides.playerBId)) {
		throw new Error(
			'appendMatchEvent: playerAId and playerBId overrides are required for PROPOSED events',
		);
	}

	return prisma.pendingGameEvent.create({
		data: {
			matchId,
			type,
			...(overrides.playerAId !== undefined
				? { playerAId: overrides.playerAId }
				: {}),
			...(overrides.playerBId !== undefined
				? { playerBId: overrides.playerBId }
				: {}),
			...(overrides.playerARating !== undefined
				? { playerARating: overrides.playerARating }
				: {}),
			...(overrides.playerBRating !== undefined
				? { playerBRating: overrides.playerBRating }
				: {}),
			...(overrides.searchAAttemptId !== undefined
				? { searchAAttemptId: overrides.searchAAttemptId }
				: {}),
			...(overrides.searchBAttemptId !== undefined
				? { searchBAttemptId: overrides.searchBAttemptId }
				: {}),
			...(overrides.actingPlayerId !== undefined
				? { actingPlayerId: overrides.actingPlayerId }
				: {}),
			...(overrides.gameResultId !== undefined
				? { gameResultId: overrides.gameResultId }
				: {}),
			...(overrides.createdAt !== undefined
				? { createdAt: overrides.createdAt }
				: {}),
		},
	});
}
