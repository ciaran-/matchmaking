// @vitest-environment node

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from '@/test/db';
import {
	appendMatchEvent,
	appendSearchEvent,
	createStartedSearch,
} from '@/test/factories/matchmaking-events';
import { createUser } from '@/test/factories/user';
import {
	getActiveMatches,
	getActiveSearches,
	getActiveSearchForUser,
	getMatchState,
	getSearchAttempt,
} from './state';

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

describe('getActiveSearchForUser', () => {
	it('returns null when the user has no events', async () => {
		const user = await createUser(db.prisma);
		const state = await getActiveSearchForUser(user.id);
		expect(state).toBeNull();
	});

	it('returns the STARTED state when the user has only a STARTED event', async () => {
		const user = await createUser(db.prisma, { currentRating: 1234 });
		const { attemptId, event } = await createStartedSearch(db.prisma, user);

		const state = await getActiveSearchForUser(user.id);

		expect(state).not.toBeNull();
		expect(state?.attemptId).toBe(attemptId);
		expect(state?.userId).toBe(user.id);
		expect(state?.rating).toBe(1234);
		expect(state?.status).toBe('STARTED');
		expect(state?.matchId).toBeNull();
		expect(state?.startedAt.getTime()).toBe(event.createdAt.getTime());
		expect(state?.latestEventAt.getTime()).toBe(event.createdAt.getTime());
	});

	it('returns the latest event when the user has multiple events for one attempt', async () => {
		const user = await createUser(db.prisma, { currentRating: 1100 });
		const { attemptId, event: started } = await createStartedSearch(
			db.prisma,
			user,
		);
		const matched = await appendSearchEvent(db.prisma, attemptId, 'MATCHED', {
			matchId: 'match-abc',
		});

		const state = await getActiveSearchForUser(user.id);

		expect(state).not.toBeNull();
		expect(state?.attemptId).toBe(attemptId);
		expect(state?.rating).toBe(1100);
		expect(state?.status).toBe('MATCHED');
		expect(state?.matchId).toBe('match-abc');
		expect(state?.startedAt.getTime()).toBe(started.createdAt.getTime());
		expect(state?.latestEventAt.getTime()).toBe(matched.createdAt.getTime());
	});

	it('returns null when the latest event is terminal (CANCELLED)', async () => {
		const user = await createUser(db.prisma);
		const { attemptId } = await createStartedSearch(db.prisma, user);
		await appendSearchEvent(db.prisma, attemptId, 'CANCELLED');

		const state = await getActiveSearchForUser(user.id);
		expect(state).toBeNull();
	});

	it('returns null when the latest event is terminal (CONSUMED)', async () => {
		const user = await createUser(db.prisma);
		const { attemptId } = await createStartedSearch(db.prisma, user);
		await appendSearchEvent(db.prisma, attemptId, 'MATCHED', {
			matchId: 'm1',
		});
		await appendSearchEvent(db.prisma, attemptId, 'CONSUMED');

		const state = await getActiveSearchForUser(user.id);
		expect(state).toBeNull();
	});

	it('returns the new attempt after re-queueing (terminal → fresh STARTED)', async () => {
		const user = await createUser(db.prisma, { currentRating: 1050 });
		const first = await createStartedSearch(db.prisma, user);
		await appendSearchEvent(db.prisma, first.attemptId, 'CANCELLED');

		const second = await createStartedSearch(db.prisma, user, {
			rating: 1075,
		});

		const state = await getActiveSearchForUser(user.id);

		expect(state).not.toBeNull();
		expect(state?.attemptId).toBe(second.attemptId);
		expect(state?.attemptId).not.toBe(first.attemptId);
		expect(state?.rating).toBe(1075);
		expect(state?.status).toBe('STARTED');
	});
});

describe('getActiveSearches', () => {
	it('returns an empty array when no events exist', async () => {
		const result = await getActiveSearches();
		expect(result).toEqual([]);
	});

	it('returns one entry per attempt whose latest event is STARTED', async () => {
		const userA = await createUser(db.prisma, { currentRating: 1000 });
		const userB = await createUser(db.prisma, { currentRating: 1100 });
		const { attemptId: aId } = await createStartedSearch(db.prisma, userA);
		const { attemptId: bId } = await createStartedSearch(db.prisma, userB);

		const result = await getActiveSearches();

		expect(result).toHaveLength(2);
		const attemptIds = result.map((r) => r.attemptId).sort();
		expect(attemptIds).toEqual([aId, bId].sort());
		expect(result.every((r) => r.status === 'STARTED')).toBe(true);
	});

	it('excludes attempts whose latest event is terminal (CANCELLED)', async () => {
		const userA = await createUser(db.prisma);
		const userB = await createUser(db.prisma);
		const a = await createStartedSearch(db.prisma, userA);
		const b = await createStartedSearch(db.prisma, userB);
		await appendSearchEvent(db.prisma, a.attemptId, 'CANCELLED');

		const result = await getActiveSearches();
		expect(result).toHaveLength(1);
		expect(result[0]?.attemptId).toBe(b.attemptId);
	});

	it('excludes attempts whose latest event is MATCHED (no longer STARTED)', async () => {
		const userA = await createUser(db.prisma);
		const userB = await createUser(db.prisma);
		const a = await createStartedSearch(db.prisma, userA);
		const b = await createStartedSearch(db.prisma, userB);
		await appendSearchEvent(db.prisma, a.attemptId, 'MATCHED', {
			matchId: 'm1',
		});

		const result = await getActiveSearches();
		expect(result).toHaveLength(1);
		expect(result[0]?.attemptId).toBe(b.attemptId);
	});

	it('returns the new STARTED attempt after a previous attempt for the same user was cancelled', async () => {
		const user = await createUser(db.prisma, { currentRating: 1000 });
		const first = await createStartedSearch(db.prisma, user);
		await appendSearchEvent(db.prisma, first.attemptId, 'CANCELLED');
		const second = await createStartedSearch(db.prisma, user);

		const result = await getActiveSearches();

		expect(result).toHaveLength(1);
		expect(result[0]?.attemptId).toBe(second.attemptId);
		expect(result[0]?.status).toBe('STARTED');
	});

	it('carries through the STARTED rating and createdAt', async () => {
		const user = await createUser(db.prisma, { currentRating: 1000 });
		const backdated = new Date(Date.now() - 60_000);
		const { attemptId, event } = await createStartedSearch(db.prisma, user, {
			rating: 950,
			createdAt: backdated,
		});

		const result = await getActiveSearches();

		expect(result).toHaveLength(1);
		expect(result[0]?.attemptId).toBe(attemptId);
		expect(result[0]?.rating).toBe(950);
		expect(result[0]?.startedAt.getTime()).toBe(event.createdAt.getTime());
	});
});

describe('getMatchState', () => {
	it('returns null when the matchId has no events', async () => {
		const state = await getMatchState('nonexistent');
		expect(state).toBeNull();
	});

	it('returns the proposal state from a PROPOSED-only match', async () => {
		const userA = await createUser(db.prisma, { currentRating: 1000 });
		const userB = await createUser(db.prisma, { currentRating: 1020 });
		const proposed = await appendMatchEvent(db.prisma, 'match-1', 'PROPOSED', {
			playerAId: userA.id,
			playerBId: userB.id,
			playerARating: 1000,
			playerBRating: 1020,
			searchAAttemptId: 'attempt-a',
			searchBAttemptId: 'attempt-b',
		});

		const state = await getMatchState('match-1');

		expect(state).not.toBeNull();
		expect(state?.matchId).toBe('match-1');
		expect(state?.playerAId).toBe(userA.id);
		expect(state?.playerBId).toBe(userB.id);
		expect(state?.playerARating).toBe(1000);
		expect(state?.playerBRating).toBe(1020);
		expect(state?.searchAAttemptId).toBe('attempt-a');
		expect(state?.searchBAttemptId).toBe('attempt-b');
		expect(state?.status).toBe('PROPOSED');
		expect(state?.confirmedBy.size).toBe(0);
		expect(state?.gameResultId).toBeNull();
		expect(state?.proposedAt.getTime()).toBe(proposed.createdAt.getTime());
		expect(state?.latestEventAt.getTime()).toBe(proposed.createdAt.getTime());
	});

	it('accumulates confirmedBy from multiple CONFIRMED_BY events', async () => {
		const userA = await createUser(db.prisma);
		const userB = await createUser(db.prisma);
		await appendMatchEvent(db.prisma, 'match-2', 'PROPOSED', {
			playerAId: userA.id,
			playerBId: userB.id,
			playerARating: 1000,
			playerBRating: 1000,
			searchAAttemptId: 'sa',
			searchBAttemptId: 'sb',
		});
		await appendMatchEvent(db.prisma, 'match-2', 'CONFIRMED_BY', {
			actingPlayerId: userA.id,
		});
		await appendMatchEvent(db.prisma, 'match-2', 'CONFIRMED_BY', {
			actingPlayerId: userB.id,
		});

		const state = await getMatchState('match-2');

		expect(state?.status).toBe('CONFIRMED_BY');
		expect(state?.confirmedBy.size).toBe(2);
		expect(state?.confirmedBy.has(userA.id)).toBe(true);
		expect(state?.confirmedBy.has(userB.id)).toBe(true);
	});

	it('reports BOTH_CONFIRMED as the latest status with both players in confirmedBy', async () => {
		const userA = await createUser(db.prisma);
		const userB = await createUser(db.prisma);
		await appendMatchEvent(db.prisma, 'm3', 'PROPOSED', {
			playerAId: userA.id,
			playerBId: userB.id,
			playerARating: 1000,
			playerBRating: 1000,
			searchAAttemptId: 'sa',
			searchBAttemptId: 'sb',
		});
		await appendMatchEvent(db.prisma, 'm3', 'CONFIRMED_BY', {
			actingPlayerId: userA.id,
		});
		await appendMatchEvent(db.prisma, 'm3', 'CONFIRMED_BY', {
			actingPlayerId: userB.id,
		});
		await appendMatchEvent(db.prisma, 'm3', 'BOTH_CONFIRMED');

		const state = await getMatchState('m3');
		expect(state?.status).toBe('BOTH_CONFIRMED');
		expect(state?.confirmedBy.size).toBe(2);
	});

	it('captures gameResultId from a PLAYED event', async () => {
		const userA = await createUser(db.prisma);
		const userB = await createUser(db.prisma);
		await appendMatchEvent(db.prisma, 'm4', 'PROPOSED', {
			playerAId: userA.id,
			playerBId: userB.id,
			playerARating: 1000,
			playerBRating: 1000,
			searchAAttemptId: 'sa',
			searchBAttemptId: 'sb',
		});
		await appendMatchEvent(db.prisma, 'm4', 'PLAYED', {
			gameResultId: 'gr-xyz',
		});

		const state = await getMatchState('m4');
		expect(state?.status).toBe('PLAYED');
		expect(state?.gameResultId).toBe('gr-xyz');
	});

	it('reports terminal status (EXPIRED) correctly', async () => {
		const userA = await createUser(db.prisma);
		const userB = await createUser(db.prisma);
		await appendMatchEvent(db.prisma, 'm5', 'PROPOSED', {
			playerAId: userA.id,
			playerBId: userB.id,
			playerARating: 1000,
			playerBRating: 1000,
			searchAAttemptId: 'sa',
			searchBAttemptId: 'sb',
		});
		await appendMatchEvent(db.prisma, 'm5', 'EXPIRED');

		const state = await getMatchState('m5');
		expect(state?.status).toBe('EXPIRED');
	});
});

describe('getSearchAttempt', () => {
	it('returns null when no events exist for the attemptId', async () => {
		const state = await getSearchAttempt('nope');
		expect(state).toBeNull();
	});

	it('returns the STARTED state for a freshly created attempt', async () => {
		const user = await createUser(db.prisma, { currentRating: 1300 });
		const { attemptId } = await createStartedSearch(db.prisma, user);

		const state = await getSearchAttempt(attemptId);

		expect(state).not.toBeNull();
		expect(state?.attemptId).toBe(attemptId);
		expect(state?.rating).toBe(1300);
		expect(state?.status).toBe('STARTED');
	});

	it('returns the terminal state even when the attempt is no longer active', async () => {
		const user = await createUser(db.prisma);
		const { attemptId } = await createStartedSearch(db.prisma, user);
		await appendSearchEvent(db.prisma, attemptId, 'CANCELLED');

		const state = await getSearchAttempt(attemptId);

		expect(state).not.toBeNull();
		expect(state?.attemptId).toBe(attemptId);
		expect(state?.status).toBe('CANCELLED');
	});

	it('returns the latest event status when the attempt has progressed', async () => {
		const user = await createUser(db.prisma);
		const { attemptId } = await createStartedSearch(db.prisma, user);
		await appendSearchEvent(db.prisma, attemptId, 'MATCHED', {
			matchId: 'm-100',
		});

		const state = await getSearchAttempt(attemptId);
		expect(state?.status).toBe('MATCHED');
		expect(state?.matchId).toBe('m-100');
	});
});

describe('getActiveMatches', () => {
	it('returns an empty array when no match events exist', async () => {
		const result = await getActiveMatches(db.prisma);
		expect(result).toEqual([]);
	});

	it('includes a match with only a PROPOSED event', async () => {
		const userA = await createUser(db.prisma, { currentRating: 1000 });
		const userB = await createUser(db.prisma, { currentRating: 1050 });
		await appendMatchEvent(db.prisma, 'match-active-1', 'PROPOSED', {
			playerAId: userA.id,
			playerBId: userB.id,
			playerARating: 1000,
			playerBRating: 1050,
			searchAAttemptId: 'sa1',
			searchBAttemptId: 'sb1',
		});

		const result = await getActiveMatches(db.prisma);

		expect(result).toHaveLength(1);
		expect(result[0]?.matchId).toBe('match-active-1');
		expect(result[0]?.status).toBe('PROPOSED');
		expect(result[0]?.playerARating).toBe(1000);
		expect(result[0]?.playerBRating).toBe(1050);
	});

	it('includes a match with CONFIRMED_BY after PROPOSED', async () => {
		const userA = await createUser(db.prisma);
		const userB = await createUser(db.prisma);
		await appendMatchEvent(db.prisma, 'match-active-2', 'PROPOSED', {
			playerAId: userA.id,
			playerBId: userB.id,
			playerARating: 1000,
			playerBRating: 1000,
			searchAAttemptId: 'sa2',
			searchBAttemptId: 'sb2',
		});
		await appendMatchEvent(db.prisma, 'match-active-2', 'CONFIRMED_BY', {
			actingPlayerId: userA.id,
		});

		const result = await getActiveMatches(db.prisma);

		expect(result).toHaveLength(1);
		expect(result[0]?.status).toBe('CONFIRMED_BY');
	});

	it('includes a BOTH_CONFIRMED match with confirmedBy.size === 2', async () => {
		const userA = await createUser(db.prisma);
		const userB = await createUser(db.prisma);
		await appendMatchEvent(db.prisma, 'match-active-3', 'PROPOSED', {
			playerAId: userA.id,
			playerBId: userB.id,
			playerARating: 1000,
			playerBRating: 1000,
			searchAAttemptId: 'sa3',
			searchBAttemptId: 'sb3',
		});
		await appendMatchEvent(db.prisma, 'match-active-3', 'CONFIRMED_BY', {
			actingPlayerId: userA.id,
		});
		await appendMatchEvent(db.prisma, 'match-active-3', 'CONFIRMED_BY', {
			actingPlayerId: userB.id,
		});
		await appendMatchEvent(db.prisma, 'match-active-3', 'BOTH_CONFIRMED');

		const result = await getActiveMatches(db.prisma);

		expect(result).toHaveLength(1);
		expect(result[0]?.status).toBe('BOTH_CONFIRMED');
		expect(result[0]?.confirmedBy.size).toBe(2);
	});

	it('excludes a match whose latest event is DECLINED', async () => {
		const userA = await createUser(db.prisma);
		const userB = await createUser(db.prisma);
		await appendMatchEvent(db.prisma, 'match-declined', 'PROPOSED', {
			playerAId: userA.id,
			playerBId: userB.id,
			playerARating: 1000,
			playerBRating: 1000,
			searchAAttemptId: 'sad',
			searchBAttemptId: 'sbd',
		});
		await appendMatchEvent(db.prisma, 'match-declined', 'DECLINED');

		const result = await getActiveMatches(db.prisma);
		expect(result).toEqual([]);
	});

	it('excludes a match whose latest event is EXPIRED', async () => {
		const userA = await createUser(db.prisma);
		const userB = await createUser(db.prisma);
		await appendMatchEvent(db.prisma, 'match-expired', 'PROPOSED', {
			playerAId: userA.id,
			playerBId: userB.id,
			playerARating: 1000,
			playerBRating: 1000,
			searchAAttemptId: 'sae',
			searchBAttemptId: 'sbe',
		});
		await appendMatchEvent(db.prisma, 'match-expired', 'EXPIRED');

		const result = await getActiveMatches(db.prisma);
		expect(result).toEqual([]);
	});

	it('excludes a match whose latest event is PLAYED', async () => {
		const userA = await createUser(db.prisma);
		const userB = await createUser(db.prisma);
		await appendMatchEvent(db.prisma, 'match-played', 'PROPOSED', {
			playerAId: userA.id,
			playerBId: userB.id,
			playerARating: 1000,
			playerBRating: 1000,
			searchAAttemptId: 'sap',
			searchBAttemptId: 'sbp',
		});
		await appendMatchEvent(db.prisma, 'match-played', 'PLAYED', {
			gameResultId: 'gr-1',
		});

		const result = await getActiveMatches(db.prisma);
		expect(result).toEqual([]);
	});

	it('returns only non-terminal matches when multiple matches exist', async () => {
		const userA = await createUser(db.prisma);
		const userB = await createUser(db.prisma);

		// Active: PROPOSED
		await appendMatchEvent(db.prisma, 'mixed-active', 'PROPOSED', {
			playerAId: userA.id,
			playerBId: userB.id,
			playerARating: 1000,
			playerBRating: 1000,
			searchAAttemptId: 'sma',
			searchBAttemptId: 'smb',
		});

		// Terminal: DECLINED
		await appendMatchEvent(db.prisma, 'mixed-declined', 'PROPOSED', {
			playerAId: userA.id,
			playerBId: userB.id,
			playerARating: 1000,
			playerBRating: 1000,
			searchAAttemptId: 'smc',
			searchBAttemptId: 'smd',
		});
		await appendMatchEvent(db.prisma, 'mixed-declined', 'DECLINED');

		// Terminal: PLAYED
		await appendMatchEvent(db.prisma, 'mixed-played', 'PROPOSED', {
			playerAId: userA.id,
			playerBId: userB.id,
			playerARating: 1000,
			playerBRating: 1000,
			searchAAttemptId: 'sme',
			searchBAttemptId: 'smf',
		});
		await appendMatchEvent(db.prisma, 'mixed-played', 'PLAYED', {
			gameResultId: 'gr-2',
		});

		const result = await getActiveMatches(db.prisma);

		expect(result).toHaveLength(1);
		expect(result[0]?.matchId).toBe('mixed-active');
	});
});
