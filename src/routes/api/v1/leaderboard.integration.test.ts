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
import type { LeaderboardEntry } from '@/lib/leaderboard';
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
import { Route } from './leaderboard';

const mockCreateClerkClient = vi.mocked(createClerkClient);

// `handlers` is typed as a union (a method record *or* a factory
// function), so it needs narrowing before a method can be indexed.
const handlers = Route.options.server?.handlers as Record<string, RouteHandler>;
const GET = handlers.GET;
const URL = 'https://example.test/api/v1/leaderboard';

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

/** A signed-in caller with a real DB row, as both credential kinds need. */
async function callerUser() {
	return createUser(db.prisma, {
		clerkId: 'user_caller',
		username: 'caller',
		currentRating: 1000,
	});
}

describe('GET /api/v1/leaderboard', () => {
	describe('authentication', () => {
		it('returns 200 for a personal API key', async () => {
			await callerUser();
			stubClerkCredential(mockCreateClerkClient, {
				kind: 'apiKey',
				clerkUserId: 'user_caller',
			});

			const res = await callRoute(
				GET,
				apiRequest(URL, {
					credential: { kind: 'apiKey', clerkUserId: 'user_caller' },
				}),
			);

			expect(res.status).toBe(200);
		});

		it('returns 200 for a session token, with an identical body', async () => {
			await callerUser();

			stubClerkCredential(mockCreateClerkClient, {
				kind: 'apiKey',
				clerkUserId: 'user_caller',
			});
			const viaKey = await readJson(await callRoute(GET, apiRequest(URL)));

			stubClerkCredential(mockCreateClerkClient, {
				kind: 'session',
				clerkUserId: 'user_caller',
			});
			const viaSession = await readJson(await callRoute(GET, apiRequest(URL)));

			expect(viaSession.status).toBe(200);
			// The whole point of the dual-credential model: downstream is
			// identical regardless of which credential was presented.
			expect(viaSession.body).toEqual(viaKey.body);
		});

		it('accepts session tokens and API keys, and nothing else', async () => {
			await callerUser();
			const authenticateRequest = stubClerkCredential(mockCreateClerkClient, {
				kind: 'apiKey',
				clerkUserId: 'user_caller',
			});

			await callRoute(GET, apiRequest(URL));

			expect(authenticateRequest).toHaveBeenCalledWith(expect.any(Request), {
				acceptsToken: ['session_token', 'api_key'],
			});
		});

		it('returns 401 in the standard envelope for a missing or invalid credential', async () => {
			stubClerkCredential(mockCreateClerkClient, { kind: 'invalid' });

			const { status, body } = await readJson<ApiErrorBody>(
				await callRoute(GET, apiRequest(URL)),
			);

			expect(status).toBe(401);
			expect(body).toEqual({
				error: {
					code: 'unauthorized',
					message: 'Missing or invalid credentials.',
				},
			});
		});

		it('returns 401 for an org-scoped key, which carries no user', async () => {
			stubClerkCredential(mockCreateClerkClient, {
				kind: 'orgKey',
				orgId: 'org_abc',
			});

			const { status, body } = await readJson<ApiErrorBody>(
				await callRoute(GET, apiRequest(URL)),
			);

			expect(status).toBe(401);
			expect(body.error.code).toBe('unauthorized');
		});

		it('returns 401 when the credential resolves to no local user', async () => {
			// Authenticated with Clerk, but no matching User row was created.
			stubClerkCredential(mockCreateClerkClient, {
				kind: 'apiKey',
				clerkUserId: 'user_stranger',
			});

			const { status, body } = await readJson<ApiErrorBody>(
				await callRoute(GET, apiRequest(URL)),
			);

			expect(status).toBe(401);
			expect(body.error.message).toBe(
				'That credential does not belong to a known user.',
			);
		});
	});

	describe('body', () => {
		beforeEach(() => {
			stubClerkCredential(mockCreateClerkClient, {
				kind: 'apiKey',
				clerkUserId: 'user_caller',
			});
		});

		it('returns a bare array ranked by rating, per the success envelope', async () => {
			await callerUser();
			await createUser(db.prisma, { username: 'top', currentRating: 1500 });
			await createUser(db.prisma, { username: 'bottom', currentRating: 900 });

			const { status, body } = await readJson<LeaderboardEntry[]>(
				await callRoute(GET, apiRequest(URL)),
			);

			expect(status).toBe(200);
			// Bare array, not { data: [...] } — reads use bare resources.
			expect(Array.isArray(body)).toBe(true);
			expect(body.map((r) => r.username)).toEqual(['top', 'caller', 'bottom']);
			expect(body.map((r) => r.rank)).toEqual([1, 2, 3]);
		});

		it('reflects real games recorded in the database', async () => {
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

			const { body } = await readJson<LeaderboardEntry[]>(
				await callRoute(GET, apiRequest(URL)),
			);

			const callerRow = body.find((r) => r.username === 'caller');
			expect(callerRow?.wins).toBe(1);
			expect(callerRow?.losses).toBe(0);
			expect(callerRow?.gamesPlayed).toBe(1);
		});

		it('never exposes email or Clerk ids', async () => {
			await callerUser();

			const res = await callRoute(GET, apiRequest(URL));
			const raw = await res.text();

			expect(raw).not.toContain('@test.local');
			expect(raw).not.toContain('user_caller');
			expect(raw).not.toContain('clerkId');
		});

		it('serialises JSON with the right content type', async () => {
			await callerUser();

			const res = await callRoute(GET, apiRequest(URL));

			expect(res.headers.get('content-type')).toContain('application/json');
		});

		it('returns an empty array when only the caller exists and has no games', async () => {
			await callerUser();

			const { body } = await readJson<LeaderboardEntry[]>(
				await callRoute(GET, apiRequest(URL)),
			);

			expect(body).toHaveLength(1);
			expect(body[0]).toEqual({
				rank: 1,
				id: expect.any(String),
				username: 'caller',
				currentRating: 1000,
				wins: 0,
				losses: 0,
				draws: 0,
				gamesPlayed: 0,
			});
		});
	});
});
