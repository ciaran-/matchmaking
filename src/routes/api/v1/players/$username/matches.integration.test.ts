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
import type { MatchHistoryPage } from '@/lib/player-match-history';
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
import { Route } from './matches';

const mockCreateClerkClient = vi.mocked(createClerkClient);
const handlers = Route.options.server?.handlers as Record<string, RouteHandler>;
const GET = handlers.GET;
const urlFor = (username: string, query = '') =>
	`https://example.test/api/v1/players/${username}/matches${query}`;

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

const get = (username: string, query = '') =>
	callRoute(GET, apiRequest(urlFor(username, query)), { username });

describe('GET /api/v1/players/:username/matches', () => {
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

	it('returns a { data, nextCursor } envelope for the calling user', async () => {
		const caller = await callerUser();
		const opponent = await createUser(db.prisma, { username: 'opponent' });

		await createGameResult(db.prisma, {
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

		const { status, body } = await readJson<MatchHistoryPage>(
			await get('caller'),
		);

		expect(status).toBe(200);
		expect(body.nextCursor).toBeNull();
		expect(body.data).toHaveLength(1);
		expect(body.data[0]).toMatchObject({
			opponentUsername: 'opponent',
			outcome: 'win',
			ratingChange: 16,
			ratingAfter: 1016,
			mode: 'ONE_VS_ONE',
		});
	});

	it('lets any authenticated caller read another player’s match history', async () => {
		await callerUser();
		await createUser(db.prisma, { username: 'someone-else' });

		const { status } = await readJson(await get('someone-else'));

		expect(status).toBe(200);
	});

	it('paginates via limit and cursor', async () => {
		const caller = await callerUser();
		const opponent = await createUser(db.prisma, { username: 'opponent' });

		for (let i = 0; i < 3; i++) {
			await createGameResult(db.prisma, {
				teamAScore: 1,
				teamBScore: 0,
				createdAt: new Date(2026, 0, 1 + i),
				participants: [
					{
						userId: caller.id,
						team: 'A',
						ratingBefore: 1000,
						ratingAfter: 1000,
						ratingChange: 0,
					},
					{
						userId: opponent.id,
						team: 'B',
						ratingBefore: 1000,
						ratingAfter: 1000,
						ratingChange: 0,
					},
				],
			});
		}

		const firstPage = await readJson<MatchHistoryPage>(
			await get('caller', '?limit=2'),
		);
		expect(firstPage.body.data).toHaveLength(2);
		expect(firstPage.body.nextCursor).not.toBeNull();

		const secondPage = await readJson<MatchHistoryPage>(
			await get(
				'caller',
				`?limit=2&cursor=${encodeURIComponent(firstPage.body.nextCursor as string)}`,
			),
		);
		expect(secondPage.body.data).toHaveLength(1);
		expect(secondPage.body.nextCursor).toBeNull();
	});

	it('returns 400 for an invalid cursor', async () => {
		await callerUser();

		const { status, body } = await readJson<ApiErrorBody>(
			await get('caller', '?cursor=not-a-real-cursor'),
		);

		expect(status).toBe(400);
		expect(body.error.code).toBe('bad_request');
	});

	it('returns 400 for a limit outside [1, 50]', async () => {
		await callerUser();

		const { status, body } = await readJson<ApiErrorBody>(
			await get('caller', '?limit=0'),
		);

		expect(status).toBe(400);
		expect(body.error.code).toBe('bad_request');
	});

	it('never exposes email or Clerk ids', async () => {
		const caller = await callerUser();
		const opponent = await createUser(db.prisma, {
			username: 'opponent',
			clerkId: 'user_opponent',
		});
		await createGameResult(db.prisma, {
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

		const raw = await (await get('caller')).text();

		expect(raw).not.toContain('@test.local');
		expect(raw).not.toContain('user_caller');
		expect(raw).not.toContain('user_opponent');
	});
});
