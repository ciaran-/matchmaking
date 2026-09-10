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
import type { PlayerProfile } from '@/lib/player-profile';
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
import { Route } from './$username';

const mockCreateClerkClient = vi.mocked(createClerkClient);
const handlers = Route.options.server?.handlers as Record<string, RouteHandler>;
const GET = handlers.GET;
const urlFor = (username: string) =>
	`https://example.test/api/v1/players/${username}`;

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

describe('GET /api/v1/players/:username', () => {
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

	it('returns the profile for the calling user', async () => {
		const caller = await callerUser();

		const { status, body } = await readJson<PlayerProfile>(await get('caller'));

		expect(status).toBe(200);
		expect(body).toMatchObject({
			id: caller.id,
			username: 'caller',
			currentRating: 1000,
			rank: 1,
			wins: 0,
			losses: 0,
			draws: 0,
			gamesPlayed: 0,
		});
	});

	it('lets any authenticated caller read another player’s profile', async () => {
		await callerUser();
		await createUser(db.prisma, { username: 'someone-else' });

		const { status } = await readJson(await get('someone-else'));

		// Unlike /matches/:matchId, profiles are not participant-scoped:
		// the same facts are already public on the leaderboard.
		expect(status).toBe(200);
	});

	it('reports a record derived from recorded scores', async () => {
		const caller = await callerUser();
		const opponent = await createUser(db.prisma, { username: 'opponent' });

		const play = (scores: [number, number], changes: [number, number]) =>
			createGameResult(db.prisma, {
				teamAScore: scores[0],
				teamBScore: scores[1],
				participants: [
					{
						userId: caller.id,
						team: 'A',
						ratingBefore: 1000,
						ratingAfter: 1000 + changes[0],
						ratingChange: changes[0],
					},
					{
						userId: opponent.id,
						team: 'B',
						ratingBefore: 1000,
						ratingAfter: 1000 + changes[1],
						ratingChange: changes[1],
					},
				],
			});

		await play([1, 0], [16, -16]);
		// A draw that still moved both ratings — the case the old
		// ratingChange-based rule got wrong.
		await play([0, 0], [-8, 8]);

		const { body } = await readJson<PlayerProfile>(await get('caller'));

		expect(body).toMatchObject({
			wins: 1,
			losses: 0,
			draws: 1,
			gamesPlayed: 2,
		});
	});

	it('never exposes email or Clerk ids', async () => {
		await callerUser();

		const raw = await (await get('caller')).text();

		expect(raw).not.toContain('@test.local');
		expect(raw).not.toContain('user_caller');
	});
});
