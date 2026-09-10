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
import type { DerivedSearchState } from '@/lib/matchmaking/state';
import { createTestDatabase, type TestDatabase } from '@/test/db';
import { createStartedSearch } from '@/test/factories/matchmaking-events';
import { createUser } from '@/test/factories/user';
import {
	apiRequest,
	callRoute,
	type RouteHandler,
	readJson,
	stubClerkCredential,
} from '@/test/http';
import { Route } from './search';

const mockCreateClerkClient = vi.mocked(createClerkClient);

const handlers = Route.options.server?.handlers as Record<string, RouteHandler>;
const GET = handlers.GET;
const URL = 'https://example.test/api/v1/me/search';

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

describe('GET /api/v1/me/search', () => {
	describe('authentication', () => {
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

		it('returns 200 for a session token, with an identical body to an API key', async () => {
			const caller = await callerUser();
			await createStartedSearch(db.prisma, caller, { rating: 1000 });

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
			expect(viaSession.body).toEqual(viaKey.body);
		});
	});

	describe('body', () => {
		beforeEach(() => {
			stubClerkCredential(mockCreateClerkClient, {
				kind: 'apiKey',
				clerkUserId: 'user_caller',
			});
		});

		it('returns null when the caller has no active search', async () => {
			await callerUser();

			const { status, body } = await readJson(
				await callRoute(GET, apiRequest(URL)),
			);

			expect(status).toBe(200);
			expect(body).toBeNull();
		});

		it("returns the caller's active search", async () => {
			const caller = await callerUser();
			const { attemptId } = await createStartedSearch(db.prisma, caller, {
				rating: 1000,
			});

			const { status, body } = await readJson<DerivedSearchState>(
				await callRoute(GET, apiRequest(URL)),
			);

			expect(status).toBe(200);
			expect(body).toMatchObject({
				attemptId,
				userId: caller.id,
				rating: 1000,
				status: 'STARTED',
				matchId: null,
			});
		});

		it("is scoped to the caller — never returns another user's search", async () => {
			const caller = await callerUser();
			const other = await createUser(db.prisma, {
				clerkId: 'user_other',
				username: 'other',
			});
			await createStartedSearch(db.prisma, other, { rating: 1200 });
			// The caller themself has no active search.

			const { body } = await readJson<DerivedSearchState | null>(
				await callRoute(GET, apiRequest(URL)),
			);

			expect(body).toBeNull();
			expect(caller.id).not.toBe(other.id);
		});

		it('returns null once the search has terminated', async () => {
			const caller = await callerUser();
			const { attemptId } = await createStartedSearch(db.prisma, caller);
			await db.prisma.matchmakingSearchEvent.create({
				data: { attemptId, userId: caller.id, type: 'CANCELLED' },
			});

			const { status, body } = await readJson(
				await callRoute(GET, apiRequest(URL)),
			);

			expect(status).toBe(200);
			expect(body).toBeNull();
		});

		it('serialises JSON with the right content type', async () => {
			await callerUser();

			const res = await callRoute(GET, apiRequest(URL));

			expect(res.headers.get('content-type')).toContain('application/json');
		});
	});
});
