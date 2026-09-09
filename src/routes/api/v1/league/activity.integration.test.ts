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
import type { LeagueActivityBundle } from '@/lib/matchmaking/dashboard';
import { createTestDatabase, type TestDatabase } from '@/test/db';
import {
	appendMatchEvent,
	createStartedSearch,
} from '@/test/factories/matchmaking-events';
import { createUser } from '@/test/factories/user';
import {
	apiRequest,
	callRoute,
	type RouteHandler,
	readJson,
	stubClerkCredential,
} from '@/test/http';
import { Route } from './activity';

const mockCreateClerkClient = vi.mocked(createClerkClient);

const handlers = Route.options.server?.handlers as Record<string, RouteHandler>;
const GET = handlers.GET;
const URL = 'https://example.test/api/v1/league/activity';

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

describe('GET /api/v1/league/activity', () => {
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

		it('returns 200 for a valid personal API key', async () => {
			await callerUser();
			stubClerkCredential(mockCreateClerkClient, {
				kind: 'apiKey',
				clerkUserId: 'user_caller',
			});

			const res = await callRoute(GET, apiRequest(URL));

			expect(res.status).toBe(200);
		});

		it('returns 200 for a session token, with an identical body', async () => {
			await callerUser();
			// `generatedAt` is a real timestamp, so pin the clock rather than
			// comparing two live calls a few milliseconds apart.
			vi.useFakeTimers();
			vi.setSystemTime(new Date('2026-06-15T12:00:00Z'));

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

			vi.useRealTimers();

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

		it('returns the bundle unchanged from getLeagueActivity', async () => {
			await callerUser();

			const { status, body } = await readJson<LeagueActivityBundle>(
				await callRoute(GET, apiRequest(URL)),
			);

			expect(status).toBe(200);
			expect(body).toEqual({
				buckets: [],
				recentResults: { last5Min: 0, lastHour: 0, last24h: 0 },
				generatedAt: expect.any(String),
			});
		});

		it('reflects real matchmaking activity from the database', async () => {
			await callerUser();
			const searcher = await createUser(db.prisma, { currentRating: 1010 });
			await createStartedSearch(db.prisma, searcher);

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

			const { body } = await readJson<LeagueActivityBundle>(
				await callRoute(GET, apiRequest(URL)),
			);

			expect(body.buckets).toEqual(
				expect.arrayContaining([
					expect.objectContaining({
						rating: 1000,
						awaitingConfirmation: 1,
					}),
					expect.objectContaining({ rating: 1050, awaitingConfirmation: 1 }),
					expect.objectContaining({ rating: 1000, searching: 1 }),
				]),
			);
		});

		it('serialises JSON with the right content type', async () => {
			await callerUser();

			const res = await callRoute(GET, apiRequest(URL));

			expect(res.headers.get('content-type')).toContain('application/json');
		});
	});

	// Keys that must never appear anywhere in the payload — mirrors the
	// denylist in `dashboard.integration.test.ts`. Preserving the
	// anonymisation contract over HTTP, not just at the lib layer, is the
	// whole point of this endpoint's test coverage.
	const FORBIDDEN_KEYS = [
		'userId',
		'clerkId',
		'attemptId',
		'matchId',
		'gameResultId',
		'username',
		'email',
		'playerAId',
		'playerBId',
		'actingPlayerId',
	];

	function collectKeys(value: unknown, acc = new Set<string>()): Set<string> {
		if (value === null || typeof value !== 'object') return acc;
		if (Array.isArray(value)) {
			value.forEach((v) => {
				collectKeys(v, acc);
			});
			return acc;
		}
		Object.keys(value).forEach((k) => {
			acc.add(k);
			collectKeys((value as Record<string, unknown>)[k], acc);
		});
		return acc;
	}

	describe('anonymisation contract', () => {
		it('returns no identifying fields anywhere in the HTTP payload', async () => {
			await callerUser();
			stubClerkCredential(mockCreateClerkClient, {
				kind: 'apiKey',
				clerkUserId: 'user_caller',
			});

			const userA = await createUser(db.prisma, { currentRating: 1000 });
			const userB = await createUser(db.prisma, { currentRating: 1050 });
			await appendMatchEvent(db.prisma, 'anon-awaiting', 'PROPOSED', {
				playerAId: userA.id,
				playerBId: userB.id,
				playerARating: 1000,
				playerBRating: 1050,
				searchAAttemptId: 'sa-anon-1',
				searchBAttemptId: 'sb-anon-1',
			});
			await appendMatchEvent(db.prisma, 'anon-playing', 'PROPOSED', {
				playerAId: userA.id,
				playerBId: userB.id,
				playerARating: 1000,
				playerBRating: 1050,
				searchAAttemptId: 'sa-anon-2',
				searchBAttemptId: 'sb-anon-2',
			});
			await appendMatchEvent(db.prisma, 'anon-playing', 'CONFIRMED_BY', {
				actingPlayerId: userA.id,
			});
			await appendMatchEvent(db.prisma, 'anon-playing', 'CONFIRMED_BY', {
				actingPlayerId: userB.id,
			});
			await appendMatchEvent(db.prisma, 'anon-playing', 'BOTH_CONFIRMED');

			const { status, body } = await readJson(
				await callRoute(GET, apiRequest(URL)),
			);

			expect(status).toBe(200);

			const raw = JSON.stringify(body);
			expect(raw).not.toContain(userA.id);
			expect(raw).not.toContain(userB.id);
			expect(raw).not.toContain('user_caller');

			const keys = collectKeys(body);
			FORBIDDEN_KEYS.forEach((forbidden) => {
				expect(keys).not.toContain(forbidden);
			});

			// Same "exactly these top-level keys" assertion as the lib test,
			// re-run at the HTTP boundary — proves the adapter didn't add or
			// drop anything on the way through.
			expect(Object.keys(body as object).sort()).toEqual([
				'buckets',
				'generatedAt',
				'recentResults',
			]);
		});
	});
});
