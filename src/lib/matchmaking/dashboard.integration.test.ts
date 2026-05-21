// @vitest-environment node

import {
	afterAll,
	afterEach,
	beforeAll,
	beforeEach,
	describe,
	expect,
	it,
	vi,
} from 'vitest';
import { createTestDatabase, type TestDatabase } from '@/test/db';
import { createGameResult } from '@/test/factories/game-result';
import {
	appendMatchEvent,
	createStartedSearch,
} from '@/test/factories/matchmaking-events';
import { createUser } from '@/test/factories/user';
import { getLeagueActivity, ratingBucket } from './dashboard';

let db: TestDatabase;

beforeAll(async () => {
	db = await createTestDatabase();
}, 120_000);

beforeEach(async () => {
	await db.reset();
	// Pin "now" to noon local time so the recent-results windows are
	// deterministic regardless of when CI runs. Local-time pinning keeps
	// `setHours(0, 0, 0, 0)` (used inside getLeagueActivity to compute
	// startOfToday) safe across timezones.
	vi.useFakeTimers();
	vi.setSystemTime(new Date('2026-06-15T12:00:00'));
});

afterEach(() => {
	vi.useRealTimers();
});

afterAll(async () => {
	await db.teardown();
});

describe('ratingBucket', () => {
	it('floors ratings into 25-point buckets', () => {
		expect(ratingBucket(1000)).toBe(1000);
		expect(ratingBucket(1010)).toBe(1000);
		expect(ratingBucket(1024)).toBe(1000);
		expect(ratingBucket(1025)).toBe(1025);
		expect(ratingBucket(1080)).toBe(1075);
	});
});

describe('getLeagueActivity', () => {
	it('returns an empty bundle when nothing is happening', async () => {
		const bundle = await getLeagueActivity(db.prisma);

		expect(bundle.buckets).toEqual([]);
		expect(bundle.recentResults).toEqual({
			last5Min: 0,
			lastHour: 0,
			today: 0,
		});
		expect(typeof bundle.generatedAt).toBe('string');
		expect(() => new Date(bundle.generatedAt).toISOString()).not.toThrow();
	});

	it('groups searchers into 25-point rating buckets', async () => {
		const u1 = await createUser(db.prisma, { currentRating: 1010 });
		const u2 = await createUser(db.prisma, { currentRating: 1020 });
		const u3 = await createUser(db.prisma, { currentRating: 1080 });
		await createStartedSearch(db.prisma, u1);
		await createStartedSearch(db.prisma, u2);
		await createStartedSearch(db.prisma, u3);

		const bundle = await getLeagueActivity(db.prisma);

		expect(bundle.buckets).toEqual([
			{ rating: 1000, searching: 2, awaitingConfirmation: 0, playing: 0 },
			{ rating: 1075, searching: 1, awaitingConfirmation: 0, playing: 0 },
		]);
	});

	it('counts a PROPOSED match as awaitingConfirmation at both players buckets', async () => {
		const userA = await createUser(db.prisma, { currentRating: 1000 });
		const userB = await createUser(db.prisma, { currentRating: 1050 });
		await appendMatchEvent(db.prisma, 'match-awaiting', 'PROPOSED', {
			playerAId: userA.id,
			playerBId: userB.id,
			playerARating: 1000,
			playerBRating: 1050,
			searchAAttemptId: 'sa',
			searchBAttemptId: 'sb',
		});

		const bundle = await getLeagueActivity(db.prisma);

		expect(bundle.buckets).toEqual([
			{ rating: 1000, searching: 0, awaitingConfirmation: 1, playing: 0 },
			{ rating: 1050, searching: 0, awaitingConfirmation: 1, playing: 0 },
		]);
	});

	it('counts a BOTH_CONFIRMED match as playing at both players buckets', async () => {
		const userA = await createUser(db.prisma, { currentRating: 1000 });
		const userB = await createUser(db.prisma, { currentRating: 1050 });
		await appendMatchEvent(db.prisma, 'match-playing', 'PROPOSED', {
			playerAId: userA.id,
			playerBId: userB.id,
			playerARating: 1000,
			playerBRating: 1050,
			searchAAttemptId: 'sa',
			searchBAttemptId: 'sb',
		});
		await appendMatchEvent(db.prisma, 'match-playing', 'CONFIRMED_BY', {
			actingPlayerId: userA.id,
		});
		await appendMatchEvent(db.prisma, 'match-playing', 'CONFIRMED_BY', {
			actingPlayerId: userB.id,
		});
		await appendMatchEvent(db.prisma, 'match-playing', 'BOTH_CONFIRMED');

		const bundle = await getLeagueActivity(db.prisma);

		expect(bundle.buckets).toEqual([
			{ rating: 1000, searching: 0, awaitingConfirmation: 0, playing: 1 },
			{ rating: 1050, searching: 0, awaitingConfirmation: 0, playing: 1 },
		]);
	});

	it('excludes terminal matches from the buckets', async () => {
		const userA = await createUser(db.prisma);
		const userB = await createUser(db.prisma);
		await appendMatchEvent(db.prisma, 'match-declined', 'PROPOSED', {
			playerAId: userA.id,
			playerBId: userB.id,
			playerARating: 1000,
			playerBRating: 1000,
			searchAAttemptId: 'sa',
			searchBAttemptId: 'sb',
		});
		await appendMatchEvent(db.prisma, 'match-declined', 'DECLINED');

		const bundle = await getLeagueActivity(db.prisma);

		expect(bundle.buckets).toEqual([]);
	});

	it('counts recent results across the three time windows', async () => {
		const now = new Date('2026-06-15T12:00:00');
		const twoMinAgo = new Date(now.getTime() - 2 * 60 * 1000);
		const thirtyMinAgo = new Date(now.getTime() - 30 * 60 * 1000);
		const fiveHoursAgo = new Date(now.getTime() - 5 * 60 * 60 * 1000);
		const yesterday = new Date(now.getTime() - 25 * 60 * 60 * 1000);

		await createGameResult(db.prisma, { createdAt: twoMinAgo });
		await createGameResult(db.prisma, { createdAt: thirtyMinAgo });
		await createGameResult(db.prisma, { createdAt: fiveHoursAgo });
		await createGameResult(db.prisma, { createdAt: yesterday });

		const bundle = await getLeagueActivity(db.prisma);

		expect(bundle.recentResults).toEqual({
			last5Min: 1,
			lastHour: 2,
			today: 3,
		});
	});

	it('produces sparse, ascending buckets with no gaps filled', async () => {
		const u1 = await createUser(db.prisma, { currentRating: 1000 });
		const u2 = await createUser(db.prisma, { currentRating: 1500 });
		await createStartedSearch(db.prisma, u1);
		await createStartedSearch(db.prisma, u2);

		const bundle = await getLeagueActivity(db.prisma);

		expect(bundle.buckets.map((b) => b.rating)).toEqual([1000, 1500]);
	});
});
