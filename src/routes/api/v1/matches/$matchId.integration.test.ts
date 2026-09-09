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
// are about the HTTP adapter: auth handling, delegation, serialisation and
// status mapping, not about Clerk's own verification.
vi.mock('@clerk/backend', () => ({
	createClerkClient: vi.fn(),
}));

import { createClerkClient } from '@clerk/backend';
import type { ApiErrorBody } from '@/lib/api/respond';
import { createTestDatabase, type TestDatabase } from '@/test/db';
import { appendMatchEvent } from '@/test/factories/matchmaking-events';
import { createUser } from '@/test/factories/user';
import {
	apiRequest,
	callRoute,
	type RouteHandler,
	readJson,
	stubClerkCredential,
} from '@/test/http';
import { Route } from './$matchId';

const mockCreateClerkClient = vi.mocked(createClerkClient);

const handlers = Route.options.server?.handlers as Record<string, RouteHandler>;
const GET = handlers.GET;
const urlFor = (matchId: string) =>
	`https://example.test/api/v1/matches/${matchId}`;

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

async function callerUser() {
	return createUser(db.prisma, {
		clerkId: 'user_caller',
		username: 'caller',
		currentRating: 1000,
	});
}

describe('GET /api/v1/matches/:matchId', () => {
	describe('authentication', () => {
		it('returns 401 in the standard envelope for a missing or invalid credential', async () => {
			stubClerkCredential(mockCreateClerkClient, { kind: 'invalid' });

			const { status, body } = await readJson<ApiErrorBody>(
				await callRoute(GET, apiRequest(urlFor('nonexistent')), {
					matchId: 'nonexistent',
				}),
			);

			expect(status).toBe(401);
			expect(body.error.code).toBe('unauthorized');
		});
	});

	describe('body', () => {
		beforeEach(() => {
			stubClerkCredential(mockCreateClerkClient, {
				kind: 'apiKey',
				clerkUserId: 'user_caller',
			});
		});

		it('returns 404 in the standard envelope when the match does not exist', async () => {
			await callerUser();

			const { status, body } = await readJson<ApiErrorBody>(
				await callRoute(GET, apiRequest(urlFor('nonexistent')), {
					matchId: 'nonexistent',
				}),
			);

			expect(status).toBe(404);
			expect(body.error.code).toBe('not_found');
		});

		it('returns the derived match state for a proposed match', async () => {
			await callerUser();
			const userA = await createUser(db.prisma, { username: 'alice' });
			const userB = await createUser(db.prisma, { username: 'bob' });
			await appendMatchEvent(db.prisma, 'match-1', 'PROPOSED', {
				playerAId: userA.id,
				playerBId: userB.id,
				playerARating: 1000,
				playerBRating: 1050,
				searchAAttemptId: 'sa-1',
				searchBAttemptId: 'sb-1',
			});

			const { status, body } = await readJson<Record<string, unknown>>(
				await callRoute(GET, apiRequest(urlFor('match-1')), {
					matchId: 'match-1',
				}),
			);

			expect(status).toBe(200);
			expect(body).toMatchObject({
				matchId: 'match-1',
				playerAId: userA.id,
				playerBId: userB.id,
				status: 'PROPOSED',
				gameResultId: null,
			});
		});

		it('serialises confirmedBy as an array, not an empty object', async () => {
			await callerUser();
			const userA = await createUser(db.prisma, { username: 'alice' });
			const userB = await createUser(db.prisma, { username: 'bob' });
			await appendMatchEvent(db.prisma, 'match-2', 'PROPOSED', {
				playerAId: userA.id,
				playerBId: userB.id,
				playerARating: 1000,
				playerBRating: 1050,
				searchAAttemptId: 'sa-2',
				searchBAttemptId: 'sb-2',
			});
			await appendMatchEvent(db.prisma, 'match-2', 'CONFIRMED_BY', {
				actingPlayerId: userA.id,
			});

			const { body } = await readJson<{ confirmedBy: unknown }>(
				await callRoute(GET, apiRequest(urlFor('match-2')), {
					matchId: 'match-2',
				}),
			);

			expect(Array.isArray(body.confirmedBy)).toBe(true);
			expect(body.confirmedBy).toEqual([userA.id]);
		});

		it('serialises JSON with the right content type', async () => {
			await callerUser();
			const userA = await createUser(db.prisma, {});
			const userB = await createUser(db.prisma, {});
			await appendMatchEvent(db.prisma, 'match-3', 'PROPOSED', {
				playerAId: userA.id,
				playerBId: userB.id,
				playerARating: 1000,
				playerBRating: 1000,
				searchAAttemptId: 'sa-3',
				searchBAttemptId: 'sb-3',
			});

			const res = await callRoute(GET, apiRequest(urlFor('match-3')), {
				matchId: 'match-3',
			});

			expect(res.headers.get('content-type')).toContain('application/json');
		});
	});
});
