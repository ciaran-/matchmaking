// @vitest-environment node

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from '@/test/db';
import {
	appendMatchEvent,
	appendSearchEvent,
	createStartedSearch,
} from '@/test/factories/matchmaking-events';
import { createUser } from '@/test/factories/user';
import { twoSearchingPlayersAtEqualRating } from '@/test/scenarios';
import { PENDING_GAME_CONFIRM_WINDOW_SECONDS } from './pending-game';
import {
	ABANDONED_AFTER_SECONDS,
	runMatcherForSearch,
	runMatcherPass,
} from './run-matcher';
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

describe('runMatcherForSearch', () => {
	it('returns { matched: true } and writes PROPOSED + MATCHED events when a candidate exists', async () => {
		const { searchA, searchB } = await twoSearchingPlayersAtEqualRating(
			db.prisma,
		);

		const result = await runMatcherForSearch(searchA.attemptId);

		expect(result).toEqual({ matched: true });

		const proposed = await db.prisma.pendingGameEvent.findMany({
			where: { type: 'PROPOSED' },
		});
		expect(proposed).toHaveLength(1);

		const finalA = await getSearchAttempt(searchA.attemptId);
		const finalB = await getSearchAttempt(searchB.attemptId);
		expect(finalA?.status).toBe('MATCHED');
		expect(finalB?.status).toBe('MATCHED');
		expect(finalA?.matchId).toBe(finalB?.matchId);
	});

	it('returns { matched: false } when no other searches exist', async () => {
		const user = await createUser(db.prisma, { currentRating: 1000 });
		const { attemptId } = await createStartedSearch(db.prisma, user);

		const result = await runMatcherForSearch(attemptId);

		expect(result).toEqual({ matched: false });

		const proposed = await db.prisma.pendingGameEvent.findMany({
			where: { type: 'PROPOSED' },
		});
		expect(proposed).toHaveLength(0);
	});

	it('returns { matched: false } when no candidate is within tolerance', async () => {
		// 1000 vs 1500 — far outside the base tolerance at t=0.
		const playerA = await createUser(db.prisma, { currentRating: 1000 });
		const playerB = await createUser(db.prisma, { currentRating: 1500 });
		const { attemptId } = await createStartedSearch(db.prisma, playerA);
		await createStartedSearch(db.prisma, playerB);

		const result = await runMatcherForSearch(attemptId);

		expect(result).toEqual({ matched: false });
	});

	it('returns { matched: false } when the attempt is not STARTED (already matched or terminal)', async () => {
		const { searchA, searchB } = await twoSearchingPlayersAtEqualRating(
			db.prisma,
		);
		// Cancel the first one so its latest event is CANCELLED.
		await appendSearchEvent(db.prisma, searchA.attemptId, 'CANCELLED');

		const result = await runMatcherForSearch(searchA.attemptId);

		expect(result).toEqual({ matched: false });

		// Sanity: no proposals at all.
		const proposed = await db.prisma.pendingGameEvent.findMany({
			where: { type: 'PROPOSED' },
		});
		expect(proposed).toHaveLength(0);

		// And searchB remains active.
		const finalB = await getSearchAttempt(searchB.attemptId);
		expect(finalB?.status).toBe('STARTED');
	});

	it('returns { matched: false } when the attemptId does not exist', async () => {
		const result = await runMatcherForSearch('does-not-exist');
		expect(result).toEqual({ matched: false });
	});
});

describe('runMatcherPass', () => {
	it('returns all-zero counts when the queue is empty', async () => {
		const result = await runMatcherPass();
		expect(result).toEqual({
			matchesCreated: 0,
			searchesReaped: 0,
			pendingGamesExpired: 0,
		});
	});

	it('pairs matchable searches, reaps stale STARTED-only attempts, and expires stale PROPOSED matches in one pass', async () => {
		// (a) Two fresh equal-rated players → expect one match in this pass.
		const { searchA, searchB } = await twoSearchingPlayersAtEqualRating(
			db.prisma,
		);

		// (b) One stale STARTED-only attempt older than the abandonment
		//     threshold → expect it to be reaped.
		const abandoner = await createUser(db.prisma, { currentRating: 1000 });
		const veryOld = new Date(
			Date.now() - (ABANDONED_AFTER_SECONDS + 60) * 1000,
		);
		const abandonedSearch = await createStartedSearch(db.prisma, abandoner, {
			createdAt: veryOld,
		});

		// (c) One stale PROPOSED match older than the confirm window →
		//     expect it to be expired.
		const stalePlayerA = await createUser(db.prisma, { currentRating: 1000 });
		const stalePlayerB = await createUser(db.prisma, { currentRating: 1000 });
		const stalePropA = await createStartedSearch(db.prisma, stalePlayerA);
		const stalePropB = await createStartedSearch(db.prisma, stalePlayerB);
		const staleMatchId = 'stale-match-id';
		const proposedAt = new Date(
			Date.now() - (PENDING_GAME_CONFIRM_WINDOW_SECONDS + 5) * 1000,
		);
		await appendMatchEvent(db.prisma, staleMatchId, 'PROPOSED', {
			playerAId: stalePlayerA.id,
			playerBId: stalePlayerB.id,
			playerARating: 1000,
			playerBRating: 1000,
			searchAAttemptId: stalePropA.attemptId,
			searchBAttemptId: stalePropB.attemptId,
			createdAt: proposedAt,
		});
		// Mark both source searches as MATCHED into the stale match so they
		// don't get picked up by the active-search matcher pass.
		await appendSearchEvent(db.prisma, stalePropA.attemptId, 'MATCHED', {
			matchId: staleMatchId,
			createdAt: proposedAt,
		});
		await appendSearchEvent(db.prisma, stalePropB.attemptId, 'MATCHED', {
			matchId: staleMatchId,
			createdAt: proposedAt,
		});

		const result = await runMatcherPass();

		expect(result.matchesCreated).toBe(1);
		expect(result.searchesReaped).toBe(1);
		expect(result.pendingGamesExpired).toBe(1);

		// Pair was matched.
		const finalA = await getSearchAttempt(searchA.attemptId);
		const finalB = await getSearchAttempt(searchB.attemptId);
		expect(finalA?.status).toBe('MATCHED');
		expect(finalB?.status).toBe('MATCHED');

		// Abandoned search now has an ABANDONED event.
		const finalAbandoner = await getSearchAttempt(abandonedSearch.attemptId);
		expect(finalAbandoner?.status).toBe('ABANDONED');

		// Stale match is now EXPIRED.
		const finalStaleMatch = await getMatchState(staleMatchId);
		expect(finalStaleMatch?.status).toBe('EXPIRED');

		// And its two source searches were also marked EXPIRED.
		const finalStalePropA = await getSearchAttempt(stalePropA.attemptId);
		const finalStalePropB = await getSearchAttempt(stalePropB.attemptId);
		expect(finalStalePropA?.status).toBe('EXPIRED');
		expect(finalStalePropB?.status).toBe('EXPIRED');
	});

	it('is idempotent: a second call when nothing has changed returns all-zero counts', async () => {
		// Set up a pairable pair plus an abandoned search plus a stale match,
		// run once, then run again — the second call should be a no-op.
		await twoSearchingPlayersAtEqualRating(db.prisma);

		const abandoner = await createUser(db.prisma, { currentRating: 1000 });
		const veryOld = new Date(
			Date.now() - (ABANDONED_AFTER_SECONDS + 60) * 1000,
		);
		await createStartedSearch(db.prisma, abandoner, { createdAt: veryOld });

		const stalePlayerA = await createUser(db.prisma, { currentRating: 1000 });
		const stalePlayerB = await createUser(db.prisma, { currentRating: 1000 });
		const stalePropA = await createStartedSearch(db.prisma, stalePlayerA);
		const stalePropB = await createStartedSearch(db.prisma, stalePlayerB);
		const staleMatchId = 'idempotent-stale-match';
		const proposedAt = new Date(
			Date.now() - (PENDING_GAME_CONFIRM_WINDOW_SECONDS + 5) * 1000,
		);
		await appendMatchEvent(db.prisma, staleMatchId, 'PROPOSED', {
			playerAId: stalePlayerA.id,
			playerBId: stalePlayerB.id,
			playerARating: 1000,
			playerBRating: 1000,
			searchAAttemptId: stalePropA.attemptId,
			searchBAttemptId: stalePropB.attemptId,
			createdAt: proposedAt,
		});
		await appendSearchEvent(db.prisma, stalePropA.attemptId, 'MATCHED', {
			matchId: staleMatchId,
			createdAt: proposedAt,
		});
		await appendSearchEvent(db.prisma, stalePropB.attemptId, 'MATCHED', {
			matchId: staleMatchId,
			createdAt: proposedAt,
		});

		const first = await runMatcherPass();
		expect(first.matchesCreated).toBe(1);
		expect(first.searchesReaped).toBe(1);
		expect(first.pendingGamesExpired).toBe(1);

		const second = await runMatcherPass();
		expect(second).toEqual({
			matchesCreated: 0,
			searchesReaped: 0,
			pendingGamesExpired: 0,
		});
	});

	it('pairs multiple pairs across the same pass when the active set has more than two players', async () => {
		// Four players, two natural pairs (1000 + 1000, 1500 + 1500).
		const a1 = await createUser(db.prisma, { currentRating: 1000 });
		const a2 = await createUser(db.prisma, { currentRating: 1000 });
		const b1 = await createUser(db.prisma, { currentRating: 1500 });
		const b2 = await createUser(db.prisma, { currentRating: 1500 });
		await createStartedSearch(db.prisma, a1);
		await createStartedSearch(db.prisma, a2);
		await createStartedSearch(db.prisma, b1);
		await createStartedSearch(db.prisma, b2);

		const result = await runMatcherPass();

		expect(result.matchesCreated).toBe(2);
		expect(result.searchesReaped).toBe(0);
		expect(result.pendingGamesExpired).toBe(0);

		// All four searches should now be MATCHED into exactly two distinct
		// matches.
		const proposed = await db.prisma.pendingGameEvent.findMany({
			where: { type: 'PROPOSED' },
		});
		expect(proposed).toHaveLength(2);
	});
});
