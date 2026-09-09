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

// Clerk is the only thing mocked here — the database is real. These tests
// are about the HTTP adapter: auth handling, validation, delegation,
// serialisation and status mapping, not about Clerk's own verification
// or `recordGame`'s Elo math (already covered by `record-game.test.ts` /
// `record-game.integration.test.ts`).
vi.mock('@clerk/backend', () => ({
	createClerkClient: vi.fn(),
}));

import { createClerkClient } from '@clerk/backend';
import type { ApiErrorBody } from '@/lib/api/respond';
import type { RecordGameOutput } from '@/lib/record-game';
import { createTestDatabase, type TestDatabase } from '@/test/db';
import { createUser } from '@/test/factories/user';
import {
	apiRequest,
	callRoute,
	type RouteHandler,
	readJson,
	stubClerkCredential,
} from '@/test/http';
import { Route } from './games';

const mockCreateClerkClient = vi.mocked(createClerkClient);

// `handlers` is typed as a union (a method record *or* a factory
// function), so it needs narrowing before a method can be indexed.
const handlers = Route.options.server?.handlers as Record<string, RouteHandler>;
const POST = handlers.POST;
const URL = 'https://example.test/api/v1/games';

let db: TestDatabase;

beforeAll(async () => {
	db = await createTestDatabase();
}, 120_000);

beforeEach(async () => {
	vi.clearAllMocks();
	await db.reset();
	process.env.CLERK_SECRET_KEY = 'sk_test_123';
	process.env.VITE_CLERK_PUBLISHABLE_KEY = 'pk_test_123';
});

afterAll(async () => {
	await db.teardown();
});

/** A signed-in caller with a real DB row. */
async function callerUser() {
	return createUser(db.prisma, {
		clerkId: 'user_caller',
		username: 'caller',
		currentRating: 1000,
	});
}

function post(body: unknown) {
	return callRoute(
		POST,
		apiRequest(URL, {
			method: 'POST',
			body: JSON.stringify(body),
			credential: { kind: 'apiKey', clerkUserId: 'user_caller' },
		}),
	);
}

describe('POST /api/v1/games', () => {
	beforeEach(() => {
		stubClerkCredential(mockCreateClerkClient, {
			kind: 'apiKey',
			clerkUserId: 'user_caller',
		});
	});

	it('returns 401 with no credential and does not touch the DB', async () => {
		stubClerkCredential(mockCreateClerkClient, { kind: 'invalid' });
		const playerA = await createUser(db.prisma, { username: 'alice' });
		const playerB = await createUser(db.prisma, { username: 'bob' });

		const { status, body } = await readJson<ApiErrorBody>(
			await post({ playerAId: playerA.id, playerBId: playerB.id, result: 'A' }),
		);

		expect(status).toBe(401);
		expect(body.error.code).toBe('unauthorized');

		const games = await db.prisma.gameResult.findMany();
		expect(games).toHaveLength(0);
	});

	it('records a game and returns 201 with rating changes', async () => {
		await callerUser();
		const playerA = await createUser(db.prisma, {
			username: 'alice',
			currentRating: 1000,
		});
		const playerB = await createUser(db.prisma, {
			username: 'bob',
			currentRating: 1000,
		});

		const { status, body } = await readJson<RecordGameOutput>(
			await post({ playerAId: playerA.id, playerBId: playerB.id, result: 'A' }),
		);

		expect(status).toBe(201);
		expect(body.ratingChangeA).toBeGreaterThan(0);
		expect(body.ratingChangeB).toBeLessThan(0);
		expect(body.gameResult.teamAScore).toBe(1);
		expect(body.gameResult.teamBScore).toBe(0);

		// Assert the DB actually changed, not just the response shape.
		const updatedA = await db.prisma.user.findUniqueOrThrow({
			where: { id: playerA.id },
		});
		const updatedB = await db.prisma.user.findUniqueOrThrow({
			where: { id: playerB.id },
		});
		expect(updatedA.currentRating).toBe(1000 + body.ratingChangeA);
		expect(updatedB.currentRating).toBe(1000 + body.ratingChangeB);

		const games = await db.prisma.gameResult.findMany();
		expect(games).toHaveLength(1);
	});

	it('returns 400 when playerAId equals playerBId, and does not record a game', async () => {
		await callerUser();
		const player = await createUser(db.prisma, { username: 'alice' });

		const { status, body } = await readJson<ApiErrorBody>(
			await post({ playerAId: player.id, playerBId: player.id, result: 'A' }),
		);

		expect(status).toBe(400);
		expect(body.error.code).toBe('bad_request');

		const games = await db.prisma.gameResult.findMany();
		expect(games).toHaveLength(0);
	});

	it('returns 404 when a player does not exist, and does not record a game', async () => {
		await callerUser();
		const playerA = await createUser(db.prisma, { username: 'alice' });

		const { status, body } = await readJson<ApiErrorBody>(
			await post({
				playerAId: playerA.id,
				playerBId: 'nonexistent-user-id',
				result: 'A',
			}),
		);

		expect(status).toBe(404);
		expect(body.error.code).toBe('not_found');

		const games = await db.prisma.gameResult.findMany();
		expect(games).toHaveLength(0);
	});

	it('returns 400 for an invalid result value, from zod validation', async () => {
		await callerUser();
		const playerA = await createUser(db.prisma, { username: 'alice' });
		const playerB = await createUser(db.prisma, { username: 'bob' });

		const { status, body } = await readJson<ApiErrorBody>(
			await post({
				playerAId: playerA.id,
				playerBId: playerB.id,
				result: 'not-a-real-result',
			}),
		);

		expect(status).toBe(400);
		expect(body.error.code).toBe('bad_request');
		// Per the conventions doc: zod's `issues` array is never
		// serialised into the response.
		expect(JSON.stringify(body)).not.toContain('issues');
		expect(JSON.stringify(body)).not.toContain('invalid_enum_value');
	});

	it('never exposes email or Clerk ids in the response', async () => {
		await callerUser();
		const playerA = await createUser(db.prisma, { username: 'alice' });
		const playerB = await createUser(db.prisma, { username: 'bob' });

		const res = await post({
			playerAId: playerA.id,
			playerBId: playerB.id,
			result: 'A',
		});
		const raw = await res.text();

		expect(raw).not.toContain('@test.local');
		expect(raw).not.toContain('user_caller');
		expect(raw).not.toContain('clerkId');
		expect(raw).not.toContain('email');
	});

	it('serialises JSON with the right content type', async () => {
		await callerUser();
		const playerA = await createUser(db.prisma, { username: 'alice' });
		const playerB = await createUser(db.prisma, { username: 'bob' });

		const res = await post({
			playerAId: playerA.id,
			playerBId: playerB.id,
			result: 'draw',
		});

		expect(res.headers.get('content-type')).toContain('application/json');
	});
});
