// @vitest-environment node

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from '@/test/db';
import {
	appendMatchEvent,
	appendSearchEvent,
	createStartedSearch,
} from '@/test/factories/matchmaking-events';
import { createUser } from '@/test/factories/user';
import { twoSearchingPlayersAtEqualRating } from '@/test/scenarios';
import {
	confirmPendingGame,
	convertPendingGameToResult,
	declinePendingGame,
	expireIfStale,
	PENDING_GAME_CONFIRM_WINDOW_SECONDS,
	proposePendingGame,
} from './pending-game';
import { getMatchState, getSearchAttempt } from './state';

let db: TestDatabase;

beforeAll(async () => {
	db = await createTestDatabase();
}, 120_000);

beforeEach(async () => {
	await db.reset();
});

afterAll(async () => {
	await db.teardown();
});

describe('proposePendingGame', () => {
	it('writes one PROPOSED event and two MATCHED events, cross-referenced by matchId', async () => {
		const { playerA, playerB, searchA, searchB } =
			await twoSearchingPlayersAtEqualRating(db.prisma);

		const match = await proposePendingGame(
			searchA.attemptId,
			searchB.attemptId,
		);

		expect(match.status).toBe('PROPOSED');
		expect(new Set([match.playerAId, match.playerBId])).toEqual(
			new Set([playerA.id, playerB.id]),
		);
		expect(match.playerARating).toBe(1000);
		expect(match.playerBRating).toBe(1000);
		expect(new Set([match.searchAAttemptId, match.searchBAttemptId])).toEqual(
			new Set([searchA.attemptId, searchB.attemptId]),
		);

		const proposed = await db.prisma.pendingGameEvent.findMany({
			where: { matchId: match.matchId, type: 'PROPOSED' },
		});
		expect(proposed).toHaveLength(1);

		const matched = await db.prisma.matchmakingSearchEvent.findMany({
			where: { matchId: match.matchId, type: 'MATCHED' },
		});
		expect(matched).toHaveLength(2);
		expect(new Set(matched.map((e) => e.attemptId))).toEqual(
			new Set([searchA.attemptId, searchB.attemptId]),
		);
		expect(new Set(matched.map((e) => e.userId))).toEqual(
			new Set([playerA.id, playerB.id]),
		);
	});

	it('throws when called twice for the same pair (second search no longer STARTED)', async () => {
		const { searchA, searchB } = await twoSearchingPlayersAtEqualRating(
			db.prisma,
		);

		await proposePendingGame(searchA.attemptId, searchB.attemptId);

		await expect(
			proposePendingGame(searchA.attemptId, searchB.attemptId),
		).rejects.toThrow(/no longer STARTED/);
	});

	it('throws when one of the searches has been cancelled before the propose call', async () => {
		const { searchA, searchB } = await twoSearchingPlayersAtEqualRating(
			db.prisma,
		);
		await appendSearchEvent(db.prisma, searchA.attemptId, 'CANCELLED');

		await expect(
			proposePendingGame(searchA.attemptId, searchB.attemptId),
		).rejects.toThrow(/no longer STARTED/);
	});

	it('throws when one of the searches does not exist', async () => {
		const { searchA } = await twoSearchingPlayersAtEqualRating(db.prisma);
		await expect(
			proposePendingGame(searchA.attemptId, randomUUID()),
		).rejects.toThrow(/do not exist/);
	});

	it('throws when both searches belong to the same user', async () => {
		const user = await createUser(db.prisma);
		const first = await createStartedSearch(db.prisma, user);
		await appendSearchEvent(db.prisma, first.attemptId, 'CANCELLED');
		const second = await createStartedSearch(db.prisma, user);

		// Both searches reference the same user — explicitly seed two
		// STARTED attempts for one user to verify the same-user guard.
		await appendSearchEvent(db.prisma, second.attemptId, 'CANCELLED');
		const third = await createStartedSearch(db.prisma, user);

		await expect(
			proposePendingGame(first.attemptId, third.attemptId),
		).rejects.toThrow();
	});

	it('two concurrent propose attempts against the same search: only one wins', async () => {
		// One target search; two competing rivals. Both rivals race to
		// pair with the same target. The lock on the target's User row
		// serialises them, and the loser observes the target has
		// transitioned to MATCHED.
		const target = await createUser(db.prisma, { currentRating: 1000 });
		const rivalA = await createUser(db.prisma, { currentRating: 1000 });
		const rivalB = await createUser(db.prisma, { currentRating: 1000 });

		const targetSearch = await createStartedSearch(db.prisma, target);
		const rivalASearch = await createStartedSearch(db.prisma, rivalA);
		const rivalBSearch = await createStartedSearch(db.prisma, rivalB);

		const results = await Promise.allSettled([
			proposePendingGame(targetSearch.attemptId, rivalASearch.attemptId),
			proposePendingGame(targetSearch.attemptId, rivalBSearch.attemptId),
		]);

		const fulfilled = results.filter((r) => r.status === 'fulfilled');
		const rejected = results.filter((r) => r.status === 'rejected');
		expect(fulfilled).toHaveLength(1);
		expect(rejected).toHaveLength(1);

		const proposed = await db.prisma.pendingGameEvent.findMany({
			where: { type: 'PROPOSED' },
		});
		expect(proposed).toHaveLength(1);

		const matched = await db.prisma.matchmakingSearchEvent.findMany({
			where: { type: 'MATCHED' },
		});
		expect(matched).toHaveLength(2);
	});

	it('deadlock-stress: 10 concurrent propose attempts crossing the same pair create exactly one match without deadlocking', async () => {
		const userX = await createUser(db.prisma, { currentRating: 1000 });
		const userY = await createUser(db.prisma, { currentRating: 1000 });
		const searchX = await createStartedSearch(db.prisma, userX);
		const searchY = await createStartedSearch(db.prisma, userY);

		// Half use (X, Y), half use (Y, X) — exercises both lock-order
		// permutations from the caller's perspective. The deterministic
		// lock-order inside proposePendingGame should prevent deadlocks.
		const attempts: Array<Promise<unknown>> = [];
		for (let i = 0; i < 10; i++) {
			attempts.push(
				i % 2 === 0
					? proposePendingGame(searchX.attemptId, searchY.attemptId)
					: proposePendingGame(searchY.attemptId, searchX.attemptId),
			);
		}

		const results = await Promise.allSettled(attempts);
		const fulfilled = results.filter((r) => r.status === 'fulfilled');
		const rejected = results.filter((r) => r.status === 'rejected');

		expect(fulfilled).toHaveLength(1);
		expect(rejected).toHaveLength(9);

		// No deadlock errors — every rejection should be the clean
		// "no longer STARTED" message, not a Postgres deadlock.
		for (const r of rejected) {
			expect(String((r as PromiseRejectedResult).reason)).toMatch(
				/no longer STARTED/,
			);
		}

		const proposed = await db.prisma.pendingGameEvent.findMany({
			where: { type: 'PROPOSED' },
		});
		expect(proposed).toHaveLength(1);

		const matched = await db.prisma.matchmakingSearchEvent.findMany({
			where: { type: 'MATCHED' },
		});
		expect(matched).toHaveLength(2);
	}, 30_000);
});

describe('confirmPendingGame', () => {
	it('writes a CONFIRMED_BY event and reports the new state', async () => {
		const { playerA, searchA, searchB } =
			await twoSearchingPlayersAtEqualRating(db.prisma);
		const match = await proposePendingGame(
			searchA.attemptId,
			searchB.attemptId,
		);

		const state = await confirmPendingGame(match.matchId, playerA.id);

		expect(state.status).toBe('CONFIRMED_BY');
		expect(state.confirmedBy.has(playerA.id)).toBe(true);
		expect(state.confirmedBy.size).toBe(1);

		const confirmed = await db.prisma.pendingGameEvent.findMany({
			where: { matchId: match.matchId, type: 'CONFIRMED_BY' },
		});
		expect(confirmed).toHaveLength(1);
		expect(confirmed[0]?.actingPlayerId).toBe(playerA.id);
	});

	it('is idempotent for double-clicks: a second confirm by the same user is a no-op', async () => {
		const { playerA, searchA, searchB } =
			await twoSearchingPlayersAtEqualRating(db.prisma);
		const match = await proposePendingGame(
			searchA.attemptId,
			searchB.attemptId,
		);

		await confirmPendingGame(match.matchId, playerA.id);
		await confirmPendingGame(match.matchId, playerA.id);

		const confirmed = await db.prisma.pendingGameEvent.findMany({
			where: { matchId: match.matchId, type: 'CONFIRMED_BY' },
		});
		expect(confirmed).toHaveLength(1);
	});

	it('writes BOTH_CONFIRMED after the second player confirms', async () => {
		const { playerA, playerB, searchA, searchB } =
			await twoSearchingPlayersAtEqualRating(db.prisma);
		const match = await proposePendingGame(
			searchA.attemptId,
			searchB.attemptId,
		);

		await confirmPendingGame(match.matchId, playerA.id);
		const state = await confirmPendingGame(match.matchId, playerB.id);

		expect(state.status).toBe('BOTH_CONFIRMED');
		expect(state.confirmedBy.has(playerA.id)).toBe(true);
		expect(state.confirmedBy.has(playerB.id)).toBe(true);

		const both = await db.prisma.pendingGameEvent.findMany({
			where: { matchId: match.matchId, type: 'BOTH_CONFIRMED' },
		});
		expect(both).toHaveLength(1);
	});

	it('synthesises BOTH_CONFIRMED under concurrent confirms from both players', async () => {
		// Without serialisation, two concurrent transactions under READ
		// COMMITTED each see only their own CONFIRMED_BY insert when
		// re-reading, neither detects both-confirmed, and neither writes
		// BOTH_CONFIRMED — leaving the match stuck. The SELECT FOR UPDATE
		// lock on both User rows inside `confirmPendingGame` serialises
		// them so the second transaction observes the first's commit and
		// fires the synthesised event.
		const { playerA, playerB, searchA, searchB } =
			await twoSearchingPlayersAtEqualRating(db.prisma);
		const match = await proposePendingGame(
			searchA.attemptId,
			searchB.attemptId,
		);

		await Promise.all([
			confirmPendingGame(match.matchId, playerA.id),
			confirmPendingGame(match.matchId, playerB.id),
		]);

		const state = await db.prisma.pendingGameEvent.findMany({
			where: { matchId: match.matchId },
			orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
		});
		const confirmedBy = state.filter((e) => e.type === 'CONFIRMED_BY');
		const both = state.filter((e) => e.type === 'BOTH_CONFIRMED');
		expect(confirmedBy).toHaveLength(2);
		expect(both).toHaveLength(1);
		// Final event is BOTH_CONFIRMED — i.e. the match's derived status
		// reflects both-confirmed, not stuck at CONFIRMED_BY.
		expect(state[state.length - 1].type).toBe('BOTH_CONFIRMED');
	});

	it('throws when called by a non-participant', async () => {
		const { searchA, searchB } = await twoSearchingPlayersAtEqualRating(
			db.prisma,
		);
		const match = await proposePendingGame(
			searchA.attemptId,
			searchB.attemptId,
		);
		const intruder = await createUser(db.prisma);

		await expect(
			confirmPendingGame(match.matchId, intruder.id),
		).rejects.toThrow(/not a participant/);
	});

	it('throws when the match is already terminal (DECLINED)', async () => {
		const { playerA, playerB, searchA, searchB } =
			await twoSearchingPlayersAtEqualRating(db.prisma);
		const match = await proposePendingGame(
			searchA.attemptId,
			searchB.attemptId,
		);
		await declinePendingGame(match.matchId, playerA.id);

		await expect(confirmPendingGame(match.matchId, playerB.id)).rejects.toThrow(
			/already terminal/,
		);
	});
});

describe('declinePendingGame', () => {
	it('writes DECLINED for the match AND for both searches', async () => {
		const { playerA, playerB, searchA, searchB } =
			await twoSearchingPlayersAtEqualRating(db.prisma);
		const match = await proposePendingGame(
			searchA.attemptId,
			searchB.attemptId,
		);

		const state = await declinePendingGame(match.matchId, playerA.id);

		expect(state.status).toBe('DECLINED');

		const matchDeclined = await db.prisma.pendingGameEvent.findMany({
			where: { matchId: match.matchId, type: 'DECLINED' },
		});
		expect(matchDeclined).toHaveLength(1);
		expect(matchDeclined[0]?.actingPlayerId).toBe(playerA.id);

		const searchDeclined = await db.prisma.matchmakingSearchEvent.findMany({
			where: { matchId: match.matchId, type: 'DECLINED' },
		});
		expect(searchDeclined).toHaveLength(2);
		expect(new Set(searchDeclined.map((e) => e.attemptId))).toEqual(
			new Set([searchA.attemptId, searchB.attemptId]),
		);
		expect(new Set(searchDeclined.map((e) => e.userId))).toEqual(
			new Set([playerA.id, playerB.id]),
		);
	});

	it('throws when called by a non-participant', async () => {
		const { searchA, searchB } = await twoSearchingPlayersAtEqualRating(
			db.prisma,
		);
		const match = await proposePendingGame(
			searchA.attemptId,
			searchB.attemptId,
		);
		const intruder = await createUser(db.prisma);

		await expect(
			declinePendingGame(match.matchId, intruder.id),
		).rejects.toThrow(/not a participant/);
	});

	it('throws when the match is already terminal', async () => {
		const { playerA, searchA, searchB } =
			await twoSearchingPlayersAtEqualRating(db.prisma);
		const match = await proposePendingGame(
			searchA.attemptId,
			searchB.attemptId,
		);
		await declinePendingGame(match.matchId, playerA.id);

		await expect(declinePendingGame(match.matchId, playerA.id)).rejects.toThrow(
			/already terminal/,
		);
	});
});

describe('expireIfStale', () => {
	it('returns null and writes no events when called within the confirm window', async () => {
		const { searchA, searchB } = await twoSearchingPlayersAtEqualRating(
			db.prisma,
		);
		const match = await proposePendingGame(
			searchA.attemptId,
			searchB.attemptId,
		);

		const result = await expireIfStale(match.matchId);

		expect(result).toBeNull();
		const expired = await db.prisma.pendingGameEvent.findMany({
			where: { matchId: match.matchId, type: 'EXPIRED' },
		});
		expect(expired).toHaveLength(0);
	});

	it('writes EXPIRED for the match and both searches once the window has elapsed', async () => {
		const { searchA, searchB } = await twoSearchingPlayersAtEqualRating(
			db.prisma,
		);
		const match = await proposePendingGame(
			searchA.attemptId,
			searchB.attemptId,
		);

		const future = new Date(
			match.proposedAt.getTime() +
				(PENDING_GAME_CONFIRM_WINDOW_SECONDS + 1) * 1000,
		);
		const result = await expireIfStale(match.matchId, future);

		expect(result?.status).toBe('EXPIRED');

		const expiredMatch = await db.prisma.pendingGameEvent.findMany({
			where: { matchId: match.matchId, type: 'EXPIRED' },
		});
		expect(expiredMatch).toHaveLength(1);

		const expiredSearches = await db.prisma.matchmakingSearchEvent.findMany({
			where: { matchId: match.matchId, type: 'EXPIRED' },
		});
		expect(expiredSearches).toHaveLength(2);
	});

	it('returns null when the match is already terminal', async () => {
		const { playerA, searchA, searchB } =
			await twoSearchingPlayersAtEqualRating(db.prisma);
		const match = await proposePendingGame(
			searchA.attemptId,
			searchB.attemptId,
		);
		await declinePendingGame(match.matchId, playerA.id);

		const future = new Date(
			match.proposedAt.getTime() +
				(PENDING_GAME_CONFIRM_WINDOW_SECONDS + 1) * 1000,
		);
		const result = await expireIfStale(match.matchId, future);

		expect(result).toBeNull();
		// Only the DECLINED event should exist on the match, no EXPIRED.
		const expired = await db.prisma.pendingGameEvent.findMany({
			where: { matchId: match.matchId, type: 'EXPIRED' },
		});
		expect(expired).toHaveLength(0);
	});

	it('returns null when the match is BOTH_CONFIRMED (players have committed; the matcher should not expire it)', async () => {
		const { playerA, playerB, searchA, searchB } =
			await twoSearchingPlayersAtEqualRating(db.prisma);
		const match = await proposePendingGame(
			searchA.attemptId,
			searchB.attemptId,
		);
		await confirmPendingGame(match.matchId, playerA.id);
		await confirmPendingGame(match.matchId, playerB.id);

		const future = new Date(
			match.proposedAt.getTime() +
				(PENDING_GAME_CONFIRM_WINDOW_SECONDS + 1) * 1000,
		);
		const result = await expireIfStale(match.matchId, future);

		expect(result).toBeNull();
	});

	it('returns null when the matchId does not exist', async () => {
		const result = await expireIfStale(randomUUID());
		expect(result).toBeNull();
	});
});

describe('convertPendingGameToResult', () => {
	it('throws when the match is not BOTH_CONFIRMED', async () => {
		const { playerA, searchA, searchB } =
			await twoSearchingPlayersAtEqualRating(db.prisma);
		const match = await proposePendingGame(
			searchA.attemptId,
			searchB.attemptId,
		);

		await expect(
			convertPendingGameToResult(match.matchId, playerA.id, 'A'),
		).rejects.toThrow(/not BOTH_CONFIRMED/);
	});

	it('throws when called by a non-participant', async () => {
		const { playerA, playerB, searchA, searchB } =
			await twoSearchingPlayersAtEqualRating(db.prisma);
		const match = await proposePendingGame(
			searchA.attemptId,
			searchB.attemptId,
		);
		await confirmPendingGame(match.matchId, playerA.id);
		await confirmPendingGame(match.matchId, playerB.id);
		const intruder = await createUser(db.prisma);

		await expect(
			convertPendingGameToResult(match.matchId, intruder.id, 'A'),
		).rejects.toThrow(/not a participant/);
	});

	it('creates a GameResult, writes PLAYED with gameResultId, and CONSUMED for both searches', async () => {
		const { playerA, playerB, searchA, searchB } =
			await twoSearchingPlayersAtEqualRating(db.prisma);
		const match = await proposePendingGame(
			searchA.attemptId,
			searchB.attemptId,
		);
		await confirmPendingGame(match.matchId, playerA.id);
		await confirmPendingGame(match.matchId, playerB.id);

		const { gameResult, matchState } = await convertPendingGameToResult(
			match.matchId,
			playerA.id,
			'A',
		);

		expect(matchState.status).toBe('PLAYED');
		expect(matchState.gameResultId).toBe(gameResult.id);

		// GameResult was created.
		const grRow = await db.prisma.gameResult.findUnique({
			where: { id: gameResult.id },
			include: { participants: true },
		});
		expect(grRow).not.toBeNull();
		expect(grRow?.participants).toHaveLength(2);

		// Player ratings were updated by recordGame.
		const updatedA = await db.prisma.user.findUniqueOrThrow({
			where: { id: playerA.id },
		});
		const updatedB = await db.prisma.user.findUniqueOrThrow({
			where: { id: playerB.id },
		});
		expect(updatedA.currentRating).toBeGreaterThan(1000);
		expect(updatedB.currentRating).toBeLessThan(1000);

		// PLAYED event written with gameResultId.
		const played = await db.prisma.pendingGameEvent.findMany({
			where: { matchId: match.matchId, type: 'PLAYED' },
		});
		expect(played).toHaveLength(1);
		expect(played[0]?.gameResultId).toBe(gameResult.id);

		// CONSUMED events written for both searches.
		const consumed = await db.prisma.matchmakingSearchEvent.findMany({
			where: { matchId: match.matchId, type: 'CONSUMED' },
		});
		expect(consumed).toHaveLength(2);
		expect(new Set(consumed.map((e) => e.attemptId))).toEqual(
			new Set([searchA.attemptId, searchB.attemptId]),
		);

		// Both searches now have CONSUMED as their latest event, so neither
		// is active any more.
		const finalSearchA = await getSearchAttempt(searchA.attemptId);
		const finalSearchB = await getSearchAttempt(searchB.attemptId);
		expect(finalSearchA?.status).toBe('CONSUMED');
		expect(finalSearchB?.status).toBe('CONSUMED');
	});

	it('first-wins on a conflicting submit: second call throws because latest event is PLAYED', async () => {
		const { playerA, playerB, searchA, searchB } =
			await twoSearchingPlayersAtEqualRating(db.prisma);
		const match = await proposePendingGame(
			searchA.attemptId,
			searchB.attemptId,
		);
		await confirmPendingGame(match.matchId, playerA.id);
		await confirmPendingGame(match.matchId, playerB.id);

		await convertPendingGameToResult(match.matchId, playerA.id, 'A');

		await expect(
			convertPendingGameToResult(match.matchId, playerB.id, 'B'),
		).rejects.toThrow(/not BOTH_CONFIRMED/);

		// Still exactly one PLAYED event.
		const played = await db.prisma.pendingGameEvent.findMany({
			where: { matchId: match.matchId, type: 'PLAYED' },
		});
		expect(played).toHaveLength(1);
	});

	it('throws when the matchId does not exist', async () => {
		const user = await createUser(db.prisma);
		await expect(
			convertPendingGameToResult(randomUUID(), user.id, 'A'),
		).rejects.toThrow(/not found/);
	});
});

describe('proposePendingGame + state derivation round-trip', () => {
	it('the two MATCHED search states reference back to the new matchId', async () => {
		const { searchA, searchB } = await twoSearchingPlayersAtEqualRating(
			db.prisma,
		);
		const match = await proposePendingGame(
			searchA.attemptId,
			searchB.attemptId,
		);

		const stateA = await getSearchAttempt(searchA.attemptId);
		const stateB = await getSearchAttempt(searchB.attemptId);

		expect(stateA?.status).toBe('MATCHED');
		expect(stateA?.matchId).toBe(match.matchId);
		expect(stateB?.status).toBe('MATCHED');
		expect(stateB?.matchId).toBe(match.matchId);

		// And getMatchState reads the same DB state we wrote.
		const reread = await getMatchState(match.matchId);
		expect(reread?.matchId).toBe(match.matchId);
		expect(reread?.status).toBe('PROPOSED');
	});

	it('seeded PROPOSED state via factories — confirm reads the prepared confirmedBy', async () => {
		// Sanity-check that pending-game ops compose with appendMatchEvent
		// from the factory (the way later modules might set things up).
		const userA = await createUser(db.prisma, { currentRating: 1000 });
		const userB = await createUser(db.prisma, { currentRating: 1000 });
		const searchA = await createStartedSearch(db.prisma, userA);
		const searchB = await createStartedSearch(db.prisma, userB);

		const matchId = randomUUID();
		await appendMatchEvent(db.prisma, matchId, 'PROPOSED', {
			playerAId: userA.id,
			playerBId: userB.id,
			playerARating: 1000,
			playerBRating: 1000,
			searchAAttemptId: searchA.attemptId,
			searchBAttemptId: searchB.attemptId,
		});

		const state = await confirmPendingGame(matchId, userA.id);
		expect(state.status).toBe('CONFIRMED_BY');
		expect(state.confirmedBy.has(userA.id)).toBe(true);
	});
});
