// @vitest-environment node

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from '@/test/db';
import {
	appendSearchEvent,
	createStartedSearch,
} from '@/test/factories/matchmaking-events';
import { createUser } from '@/test/factories/user';
import { cancelSearch, createSearch, reapAbandonedSearches } from './search';

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

describe('createSearch', () => {
	it('writes a STARTED event snapshotting the user current rating', async () => {
		const user = await createUser(db.prisma, { currentRating: 1234 });

		const state = await createSearch(user.id);

		expect(state.userId).toBe(user.id);
		expect(state.status).toBe('STARTED');
		expect(state.rating).toBe(1234);
		expect(state.matchId).toBeNull();

		const events = await db.prisma.matchmakingSearchEvent.findMany({
			where: { userId: user.id },
		});
		expect(events).toHaveLength(1);
		expect(events[0]?.type).toBe('STARTED');
		expect(events[0]?.rating).toBe(1234);
		expect(events[0]?.attemptId).toBe(state.attemptId);
	});

	it('is idempotent: a second call returns the same attempt without writing a new event', async () => {
		const user = await createUser(db.prisma);

		const first = await createSearch(user.id);
		const second = await createSearch(user.id);

		expect(second.attemptId).toBe(first.attemptId);

		const events = await db.prisma.matchmakingSearchEvent.findMany({
			where: { userId: user.id },
		});
		expect(events).toHaveLength(1);
	});

	it('returns the existing attempt when the latest event is MATCHED (still active)', async () => {
		const user = await createUser(db.prisma);
		const { attemptId } = await createStartedSearch(db.prisma, user);
		await appendSearchEvent(db.prisma, attemptId, 'MATCHED', {
			matchId: 'm-abc',
		});

		const state = await createSearch(user.id);

		expect(state.attemptId).toBe(attemptId);
		expect(state.status).toBe('MATCHED');

		const events = await db.prisma.matchmakingSearchEvent.findMany({
			where: { userId: user.id },
		});
		// Still just STARTED + MATCHED — no new STARTED event was written.
		expect(events).toHaveLength(2);
	});

	it('creates a fresh attemptId after a CANCELLED previous attempt', async () => {
		const user = await createUser(db.prisma);

		const first = await createSearch(user.id);
		await cancelSearch(user.id);
		const second = await createSearch(user.id);

		expect(second.attemptId).not.toBe(first.attemptId);
		expect(second.status).toBe('STARTED');

		const events = await db.prisma.matchmakingSearchEvent.findMany({
			where: { userId: user.id },
			orderBy: { createdAt: 'asc' },
		});
		expect(events.map((e) => e.type)).toEqual([
			'STARTED',
			'CANCELLED',
			'STARTED',
		]);
	});

	it('throws when the user does not exist', async () => {
		await expect(createSearch('nonexistent-user-id')).rejects.toThrow(
			/User not found/,
		);
	});

	it('concurrent calls for the same user produce exactly one STARTED event', async () => {
		// The critical SELECT FOR UPDATE test: two parallel createSearch
		// calls for the same user must serialise — the first writes a
		// STARTED event, the second sees it and returns idempotently.
		const user = await createUser(db.prisma);

		const [a, b] = await Promise.all([
			createSearch(user.id),
			createSearch(user.id),
		]);

		expect(a.attemptId).toBe(b.attemptId);

		const events = await db.prisma.matchmakingSearchEvent.findMany({
			where: { userId: user.id, type: 'STARTED' },
		});
		expect(events).toHaveLength(1);
	});
});

describe('cancelSearch', () => {
	it('appends a CANCELLED event referencing the active attempt', async () => {
		const user = await createUser(db.prisma);
		const created = await createSearch(user.id);

		const state = await cancelSearch(user.id);

		expect(state.attemptId).toBe(created.attemptId);
		expect(state.status).toBe('CANCELLED');

		const events = await db.prisma.matchmakingSearchEvent.findMany({
			where: { attemptId: created.attemptId },
			orderBy: { createdAt: 'asc' },
		});
		expect(events).toHaveLength(2);
		expect(events[1]?.type).toBe('CANCELLED');
		expect(events[1]?.userId).toBe(user.id);
		expect(events[1]?.attemptId).toBe(created.attemptId);
	});

	it('throws when the user has no events at all', async () => {
		const user = await createUser(db.prisma);
		await expect(cancelSearch(user.id)).rejects.toThrow(/No active search/);
	});

	it('throws when the latest event is already terminal', async () => {
		const user = await createUser(db.prisma);
		const { attemptId } = await createStartedSearch(db.prisma, user);
		await appendSearchEvent(db.prisma, attemptId, 'CANCELLED');

		await expect(cancelSearch(user.id)).rejects.toThrow(/No active search/);
	});
});

describe('reapAbandonedSearches', () => {
	it('returns 0 when there are no searches at all', async () => {
		const reaped = await reapAbandonedSearches(300);
		expect(reaped).toBe(0);
	});

	it('does not reap fresh STARTED attempts', async () => {
		const user = await createUser(db.prisma);
		await createStartedSearch(db.prisma, user);

		const reaped = await reapAbandonedSearches(300);

		expect(reaped).toBe(0);
		const events = await db.prisma.matchmakingSearchEvent.findMany({
			where: { userId: user.id },
		});
		expect(events).toHaveLength(1);
	});

	it('appends ABANDONED for STARTED attempts older than the threshold', async () => {
		const user = await createUser(db.prisma);
		const oldDate = new Date(Date.now() - 10 * 60 * 1000); // 10 minutes ago
		const { attemptId } = await createStartedSearch(db.prisma, user, {
			createdAt: oldDate,
		});

		const reaped = await reapAbandonedSearches(300); // 5 minutes
		expect(reaped).toBe(1);

		const events = await db.prisma.matchmakingSearchEvent.findMany({
			where: { attemptId },
			orderBy: { createdAt: 'asc' },
		});
		expect(events.map((e) => e.type)).toEqual(['STARTED', 'ABANDONED']);
		expect(events[1]?.userId).toBe(user.id);
	});

	it('reaps multiple stale attempts in one pass and counts them', async () => {
		const userA = await createUser(db.prisma);
		const userB = await createUser(db.prisma);
		const old = new Date(Date.now() - 10 * 60 * 1000);
		await createStartedSearch(db.prisma, userA, { createdAt: old });
		await createStartedSearch(db.prisma, userB, { createdAt: old });

		const reaped = await reapAbandonedSearches(300);
		expect(reaped).toBe(2);

		const abandoned = await db.prisma.matchmakingSearchEvent.findMany({
			where: { type: 'ABANDONED' },
		});
		expect(abandoned).toHaveLength(2);
	});

	it('does NOT touch attempts whose latest event is MATCHED', async () => {
		const user = await createUser(db.prisma);
		const old = new Date(Date.now() - 10 * 60 * 1000);
		const { attemptId } = await createStartedSearch(db.prisma, user, {
			createdAt: old,
		});
		await appendSearchEvent(db.prisma, attemptId, 'MATCHED', {
			matchId: 'm-stale',
		});

		const reaped = await reapAbandonedSearches(300);

		expect(reaped).toBe(0);
		const events = await db.prisma.matchmakingSearchEvent.findMany({
			where: { attemptId },
		});
		// Still just STARTED + MATCHED — no ABANDONED appended.
		expect(events).toHaveLength(2);
		expect(events.find((e) => e.type === 'ABANDONED')).toBeUndefined();
	});

	it('does NOT touch attempts whose latest event is CANCELLED (even if old)', async () => {
		const user = await createUser(db.prisma);
		const old = new Date(Date.now() - 10 * 60 * 1000);
		const { attemptId } = await createStartedSearch(db.prisma, user, {
			createdAt: old,
		});
		await appendSearchEvent(db.prisma, attemptId, 'CANCELLED');

		const reaped = await reapAbandonedSearches(300);

		expect(reaped).toBe(0);
	});

	it('only reaps the stale attempts, leaving fresh ones untouched', async () => {
		const userA = await createUser(db.prisma);
		const userB = await createUser(db.prisma);
		const old = new Date(Date.now() - 10 * 60 * 1000);
		const stale = await createStartedSearch(db.prisma, userA, {
			createdAt: old,
		});
		const fresh = await createStartedSearch(db.prisma, userB);

		const reaped = await reapAbandonedSearches(300);

		expect(reaped).toBe(1);

		const staleEvents = await db.prisma.matchmakingSearchEvent.findMany({
			where: { attemptId: stale.attemptId },
		});
		expect(staleEvents.map((e) => e.type).sort()).toEqual([
			'ABANDONED',
			'STARTED',
		]);

		const freshEvents = await db.prisma.matchmakingSearchEvent.findMany({
			where: { attemptId: fresh.attemptId },
		});
		expect(freshEvents).toHaveLength(1);
		expect(freshEvents[0]?.type).toBe('STARTED');
	});
});
