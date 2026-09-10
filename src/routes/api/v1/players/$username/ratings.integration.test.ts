// @vitest-environment node

import {
	afterAll,
	beforeAll,
	beforeEach,
	describe,
	expect,
	it,
	vi,
} from 'vitest';

vi.mock('@clerk/backend', () => ({
	createClerkClient: vi.fn(),
}));

import { createClerkClient } from '@clerk/backend';
import type { ApiErrorBody } from '@/lib/api/respond';
import type { RatingHistoryPoint } from '@/lib/player-rating-history';
import { createTestDatabase, type TestDatabase } from '@/test/db';
import { createGameResult } from '@/test/factories/game-result';
import { createUser } from '@/test/factories/user';
import {
	apiRequest,
	callRoute,
	type RouteHandler,
	readJson,
	stubClerkCredential,
} from '@/test/http';
import { Route } from './ratings';

const mockCreateClerkClient = vi.mocked(createClerkClient);
const handlers = Route.options.server?.handlers as Record<string, RouteHandler>;
const GET = handlers.GET;
const urlFor = (username: string) =>
	`https://example.test/api/v1/players/${username}/ratings`;

let db: TestDatabase;

beforeAll(async () => {
	db = await createTestDatabase();
}, 120_000);

beforeEach(async () => {
	vi.clearAllMocks();
	await db.reset();
	process.env.CLERK_SECRET_KEY = 'sk_test_123';
	process.env.VITE_CLERK_PUBLISHABLE_KEY = 'pk_test_123';
	stubClerkCredential(mockCreateClerkClient, {
		kind: 'apiKey',
		clerkUserId: 'user_caller',
	});
});

afterAll(async () => {
	await db.teardown();
});

async function callerUser() {
	return createUser(db.prisma, {
		clerkId: 'user_caller',
		username: 'caller',
	});
}

const get = (username: string) =>
	callRoute(GET, apiRequest(urlFor(username)), { username });

describe('GET /api/v1/players/:username/ratings', () => {
	it('returns 401 without a credential', async () => {
		await callerUser();
		stubClerkCredential(mockCreateClerkClient, { kind: 'invalid' });

		const { status, body } = await readJson<ApiErrorBody>(await get('caller'));

		expect(status).toBe(401);
		expect(body.error.code).toBe('unauthorized');
	});

	it('returns 404 in the standard envelope for an unknown player', async () => {
		await callerUser();

		const { status, body } = await readJson<ApiErrorBody>(await get('nobody'));

		expect(status).toBe(404);
		expect(body.error.code).toBe('not_found');
	});

	it('returns an empty array for a player with no games', async () => {
		await callerUser();

		const { status, body } = await readJson<RatingHistoryPoint[]>(
			await get('caller'),
		);

		expect(status).toBe(200);
		expect(body).toEqual([]);
	});

	it('lets any authenticated caller read another player’s rating history', async () => {
		await callerUser();
		await createUser(db.prisma, { username: 'someone-else' });

		const { status } = await readJson(await get('someone-else'));

		// Same stance as GET /api/v1/players/:username: not participant-scoped.
		expect(status).toBe(200);
	});

	it('returns rating snapshots ascending by game time', async () => {
		const caller = await callerUser();
		const opponent = await createUser(db.prisma, { username: 'opponent' });

		const first = await createGameResult(db.prisma, {
			createdAt: new Date('2026-01-01T00:00:00.000Z'),
			teamAScore: 1,
			teamBScore: 0,
			participants: [
				{
					userId: caller.id,
					team: 'A',
					ratingBefore: 1000,
					ratingAfter: 1016,
					ratingChange: 16,
				},
				{
					userId: opponent.id,
					team: 'B',
					ratingBefore: 1000,
					ratingAfter: 984,
					ratingChange: -16,
				},
			],
		});
		const second = await createGameResult(db.prisma, {
			createdAt: new Date('2026-01-02T00:00:00.000Z'),
			teamAScore: 0,
			teamBScore: 1,
			participants: [
				{
					userId: caller.id,
					team: 'A',
					ratingBefore: 1016,
					ratingAfter: 1000,
					ratingChange: -16,
				},
				{
					userId: opponent.id,
					team: 'B',
					ratingBefore: 984,
					ratingAfter: 1000,
					ratingChange: 16,
				},
			],
		});

		const { status, body } = await readJson<RatingHistoryPoint[]>(
			await get('caller'),
		);

		expect(status).toBe(200);
		expect(body).toEqual([
			{ rating: 1016, at: '2026-01-01T00:00:00.000Z', gameResultId: first.id },
			{ rating: 1000, at: '2026-01-02T00:00:00.000Z', gameResultId: second.id },
		]);
	});

	it('never exposes email or Clerk ids', async () => {
		const caller = await callerUser();
		const opponent = await createUser(db.prisma, { username: 'opponent' });

		await createGameResult(db.prisma, {
			participants: [
				{
					userId: caller.id,
					team: 'A',
					ratingBefore: 1000,
					ratingAfter: 1016,
					ratingChange: 16,
				},
				{
					userId: opponent.id,
					team: 'B',
					ratingBefore: 1000,
					ratingAfter: 984,
					ratingChange: -16,
				},
			],
		});

		const raw = await (await get('caller')).text();

		expect(raw).not.toContain('@test.local');
		expect(raw).not.toContain('user_caller');
	});
});
