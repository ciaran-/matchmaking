// @vitest-environment node

import { randomUUID } from 'node:crypto';
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
// are about the HTTP adapter for the matchmaking lifecycle (T9): auth
// handling, per-user scoping, delegation to `src/lib/matchmaking/`,
// serialisation, and status mapping — not the lib's own business logic,
// which already has unit + integration coverage of its own.
vi.mock('@clerk/backend', () => ({
	createClerkClient: vi.fn(),
}));

import { createClerkClient } from '@clerk/backend';
import type { ApiErrorBody } from '@/lib/api/respond';
import { createTestDatabase, type TestDatabase } from '@/test/db';
import { createUser } from '@/test/factories/user';
import {
	apiRequest,
	callRoute,
	type RouteHandler,
	readJson,
	stubClerkCredential,
} from '@/test/http';
import { Route as ConfirmRoute } from './matches/$matchId/confirm';
import { Route as DeclineRoute } from './matches/$matchId/decline';
import { Route as ResultRoute } from './matches/$matchId/result';
import { Route as SearchRoute } from './search';
import { Route as CancelRoute } from './search/cancel';

const mockCreateClerkClient = vi.mocked(createClerkClient);

function handlersOf(route: {
	options: { server?: { handlers?: unknown } };
}): Record<string, RouteHandler> {
	return route.options.server?.handlers as Record<string, RouteHandler>;
}

const search = handlersOf(SearchRoute);
const cancel = handlersOf(CancelRoute);
const confirm = handlersOf(ConfirmRoute);
const decline = handlersOf(DeclineRoute);
const result = handlersOf(ResultRoute);

const SEARCH_URL = 'https://example.test/api/v1/search';
const CANCEL_URL = 'https://example.test/api/v1/search/cancel';
const matchUrl = (matchId: string, action: string) =>
	`https://example.test/api/v1/matches/${matchId}/${action}`;

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

function asUser(clerkUserId: string) {
	stubClerkCredential(mockCreateClerkClient, { kind: 'apiKey', clerkUserId });
}

function asInvalid() {
	stubClerkCredential(mockCreateClerkClient, { kind: 'invalid' });
}

/** Minimal shape assertions need from the wire responses. */
interface SearchStateBody {
	attemptId: string;
	userId: string;
	status: string;
	matchId: string | null;
}
interface MatchStateBody {
	matchId: string;
	playerAId: string;
	playerBId: string;
	status: string;
	confirmedBy: string[];
	gameResultId: string | null;
}
interface PollBody {
	dbUserId: string;
	search: SearchStateBody | null;
	match: MatchStateBody | null;
	opponent: { id: string; username: string; currentRating: number } | null;
	gameResult: { id: string; participants: unknown[] } | null;
}

async function startSearch(clerkUserId: string) {
	asUser(clerkUserId);
	return readJson<SearchStateBody>(
		await callRoute(search.POST, apiRequest(SEARCH_URL, { method: 'POST' })),
	);
}

async function poll(clerkUserId: string) {
	asUser(clerkUserId);
	return readJson<PollBody>(
		await callRoute(search.GET, apiRequest(SEARCH_URL)),
	);
}

async function doConfirm(clerkUserId: string, matchId: string) {
	asUser(clerkUserId);
	return readJson<MatchStateBody | ApiErrorBody>(
		await callRoute(
			confirm.POST,
			apiRequest(matchUrl(matchId, 'confirm'), { method: 'POST' }),
			{ matchId },
		),
	);
}

async function doDecline(clerkUserId: string, matchId: string) {
	asUser(clerkUserId);
	return readJson<MatchStateBody | ApiErrorBody>(
		await callRoute(
			decline.POST,
			apiRequest(matchUrl(matchId, 'decline'), { method: 'POST' }),
			{ matchId },
		),
	);
}

async function doResult(
	clerkUserId: string,
	matchId: string,
	reportedResult: 'A' | 'B' | 'draw',
) {
	asUser(clerkUserId);
	return readJson<
		| {
				gameResult: { id: string; participants: unknown[] };
				match: MatchStateBody;
		  }
		| ApiErrorBody
	>(
		await callRoute(
			result.POST,
			apiRequest(matchUrl(matchId, 'result'), {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ result: reportedResult }),
			}),
			{ matchId },
		),
	);
}

/**
 * Two equal-rated users whose searches pair on the hot path (base
 * tolerance is 50 Elo, see `tolerance.ts`) — driven entirely over HTTP,
 * not seeded via the scenario factories, so the match is a real product
 * of `POST /api/v1/search` twice.
 */
async function twoUsersMatched(clerkA: string, clerkB: string) {
	const a = await createUser(db.prisma, {
		clerkId: clerkA,
		username: `${clerkA}-name`,
		currentRating: 1000,
	});
	const b = await createUser(db.prisma, {
		clerkId: clerkB,
		username: `${clerkB}-name`,
		currentRating: 1000,
	});

	await startSearch(clerkA);
	const { body: bSearch } = await startSearch(clerkB);
	const matchId = bSearch.matchId;
	if (!matchId) throw new Error('twoUsersMatched: hot-path match did not fire');

	return { a, b, matchId };
}

describe('matchmaking lifecycle (T9)', () => {
	describe('happy path: start -> match -> confirm x2 -> result', () => {
		it('drives the full lifecycle over HTTP', async () => {
			const { a, b, matchId } = await twoUsersMatched('user_a', 'user_b');

			const afterA = await doConfirm('user_a', matchId);
			expect(afterA.status).toBe(200);
			const matchAfterA = afterA.body as MatchStateBody;
			expect(matchAfterA.status).toBe('CONFIRMED_BY');
			expect(matchAfterA.confirmedBy).toEqual([a.id]);

			const afterB = await doConfirm('user_b', matchId);
			expect(afterB.status).toBe(200);
			const matchAfterB = afterB.body as MatchStateBody;
			expect(matchAfterB.status).toBe('BOTH_CONFIRMED');
			expect([...matchAfterB.confirmedBy].sort()).toEqual([a.id, b.id].sort());

			// A reports the result from their own perspective: "I won".
			const { status: resultStatus, body: resultBody } = await doResult(
				'user_a',
				matchId,
				'A',
			);
			expect(resultStatus).toBe(201);
			const { gameResult, match: finalMatch } = resultBody as {
				gameResult: {
					id: string;
					participants: { userId: string; ratingChange: number }[];
				};
				match: MatchStateBody;
			};
			expect(finalMatch.status).toBe('PLAYED');
			expect(finalMatch.gameResultId).toBe(gameResult.id);

			const aParticipant = gameResult.participants.find(
				(p) => p.userId === a.id,
			);
			const bParticipant = gameResult.participants.find(
				(p) => p.userId === b.id,
			);
			expect(aParticipant?.ratingChange).toBeGreaterThan(0);
			expect(bParticipant?.ratingChange).toBeLessThan(0);

			// PII: no email or Clerk id anywhere in the lifecycle responses.
			const raw = JSON.stringify({ afterA, afterB, resultBody });
			expect(raw).not.toContain('@test.local');
			expect(raw).not.toContain('user_a');
			expect(raw).not.toContain('user_b');
			expect(raw).not.toContain('clerkId');
		});

		it('reverses the flip when the reporter is playerB', async () => {
			// Same lifecycle, but this time the *other* player reports —
			// exercises the reporter-perspective flip in
			// matches.$matchId.result.ts.
			const { a, b, matchId } = await twoUsersMatched('user_c', 'user_d');
			await doConfirm('user_c', matchId);
			await doConfirm('user_d', matchId);

			// Whichever of a/b landed as playerB reports "I won" ('A' in
			// reporter-perspective); assert the *reporter* (not
			// necessarily playerA) is the one whose rating went up.
			const { status, body } = await doResult('user_d', matchId, 'A');
			expect(status).toBe(201);
			const { gameResult } = body as {
				gameResult: {
					participants: { userId: string; ratingChange: number }[];
				};
			};
			const dUser = await db.prisma.user.findUnique({
				where: { clerkId: 'user_d' },
			});
			const reporterParticipant = gameResult.participants.find(
				(p) => p.userId === dUser?.id,
			);
			expect(reporterParticipant?.ratingChange).toBeGreaterThan(0);
			// Sanity: a and b are indeed the two participants.
			const ids = gameResult.participants.map((p) => p.userId).sort();
			expect(ids).toEqual([a.id, b.id].sort());
		});
	});

	describe('decline path', () => {
		it('declining marks the match DECLINED and both source searches DECLINED', async () => {
			const { matchId } = await twoUsersMatched('user_e', 'user_f');

			const { status, body } = await doDecline('user_e', matchId);
			expect(status).toBe(200);
			expect((body as MatchStateBody).status).toBe('DECLINED');

			// DECLINED is a terminal search status, so getActiveSearchForUser
			// (what GET /api/v1/search's `search` field reflects) returns null
			// for both players — same as pollSearchStatusFn. The match itself
			// is still readable via the poll's `match` field, which is how
			// the terminal state actually surfaces.
			const pollE = await poll('user_e');
			expect(pollE.body.search).toBeNull();
			expect(pollE.body.match?.status).toBe('DECLINED');
			const pollF = await poll('user_f');
			expect(pollF.body.search).toBeNull();
			expect(pollF.body.match?.status).toBe('DECLINED');
		});

		it('rejects a second decline on an already-terminal match with 409', async () => {
			const { matchId } = await twoUsersMatched('user_g', 'user_h');
			await doDecline('user_g', matchId);

			const { status, body } = await doDecline('user_h', matchId);
			expect(status).toBe(409);
			expect((body as ApiErrorBody).error.code).toBe('conflict');
		});
	});

	describe('cross-user action attempts rejected with 403', () => {
		it('confirm: a non-participant cannot confirm someone else’s match', async () => {
			const { matchId } = await twoUsersMatched('user_i', 'user_j');
			await createUser(db.prisma, { clerkId: 'user_stranger' });

			const { status, body } = await doConfirm('user_stranger', matchId);

			expect(status).toBe(403);
			expect((body as ApiErrorBody).error.code).toBe('forbidden');
		});

		it('decline: a non-participant cannot decline someone else’s match', async () => {
			const { matchId } = await twoUsersMatched('user_k', 'user_l');
			await createUser(db.prisma, { clerkId: 'user_stranger2' });

			const { status, body } = await doDecline('user_stranger2', matchId);

			expect(status).toBe(403);
			expect((body as ApiErrorBody).error.code).toBe('forbidden');
		});

		it('result: a non-participant cannot record a result for someone else’s match', async () => {
			const { matchId } = await twoUsersMatched('user_m', 'user_n');
			await doConfirm('user_m', matchId);
			await doConfirm('user_n', matchId);
			await createUser(db.prisma, { clerkId: 'user_stranger3' });

			const { status, body } = await doResult('user_stranger3', matchId, 'A');

			expect(status).toBe(403);
			expect((body as ApiErrorBody).error.code).toBe('forbidden');
		});
	});

	describe('poll reflects state transitions', () => {
		it('null -> STARTED -> MATCHED -> confirmed -> PLAYED', async () => {
			await createUser(db.prisma, {
				clerkId: 'user_o',
				username: 'user-o-name',
				currentRating: 1000,
			});
			await createUser(db.prisma, {
				clerkId: 'user_p',
				username: 'user-p-name',
				currentRating: 1000,
			});

			const before = await poll('user_o');
			expect(before.body.search).toBeNull();
			expect(before.body.match).toBeNull();

			await startSearch('user_o');
			const searching = await poll('user_o');
			expect(searching.body.search?.status).toBe('STARTED');

			await startSearch('user_p');
			const matched = await poll('user_o');
			expect(matched.body.search?.status).toBe('MATCHED');
			expect(matched.body.match?.status).toBe('PROPOSED');
			expect(matched.body.opponent?.username).toBe('user-p-name');

			const matchId = matched.body.match?.matchId as string;
			await doConfirm('user_o', matchId);
			const afterOwnConfirm = await poll('user_o');
			expect(afterOwnConfirm.body.match?.status).toBe('CONFIRMED_BY');

			await doConfirm('user_p', matchId);
			const bothConfirmed = await poll('user_o');
			expect(bothConfirmed.body.match?.status).toBe('BOTH_CONFIRMED');

			await doResult('user_o', matchId, 'draw');
			const played = await poll('user_o');
			expect(played.body.match?.status).toBe('PLAYED');
			expect(played.body.gameResult).not.toBeNull();
			// The search is CONSUMED, so getActiveSearchForUser now returns
			// null — the poll leans on the match/gameResult fields to still
			// render the result screen (see search.ts's GET handler).
			expect(played.body.search).toBeNull();
		});
	});

	describe('search / cancel', () => {
		it('POST /api/v1/search is idempotent for a second call by the same user', async () => {
			await createUser(db.prisma, { clerkId: 'user_q', currentRating: 1000 });

			const first = await startSearch('user_q');
			const second = await startSearch('user_q');

			expect(first.body.attemptId).toBe(second.body.attemptId);
			expect(second.body.status).toBe('STARTED');
		});

		it('cancels an active search', async () => {
			await createUser(db.prisma, { clerkId: 'user_r', currentRating: 1000 });
			await startSearch('user_r');

			asUser('user_r');
			const { status, body } = await readJson<SearchStateBody>(
				await callRoute(
					cancel.POST,
					apiRequest(CANCEL_URL, { method: 'POST' }),
				),
			);

			expect(status).toBe(200);
			expect(body.status).toBe('CANCELLED');
		});

		it('cancelling with nothing active maps to 409, not 500', async () => {
			await createUser(db.prisma, { clerkId: 'user_s' });

			asUser('user_s');
			const { status, body } = await readJson<ApiErrorBody>(
				await callRoute(
					cancel.POST,
					apiRequest(CANCEL_URL, { method: 'POST' }),
				),
			);

			expect(status).toBe(409);
			expect(body.error.code).toBe('conflict');
		});
	});

	describe('missing credential -> 401', () => {
		it.each([
			[
				'GET /api/v1/search',
				() => callRoute(search.GET, apiRequest(SEARCH_URL)),
			],
			[
				'POST /api/v1/search',
				() =>
					callRoute(search.POST, apiRequest(SEARCH_URL, { method: 'POST' })),
			],
			[
				'POST /api/v1/search/cancel',
				() =>
					callRoute(cancel.POST, apiRequest(CANCEL_URL, { method: 'POST' })),
			],
			[
				'POST /api/v1/matches/:id/confirm',
				() =>
					callRoute(
						confirm.POST,
						apiRequest(matchUrl(randomUUID(), 'confirm'), { method: 'POST' }),
						{ matchId: randomUUID() },
					),
			],
			[
				'POST /api/v1/matches/:id/decline',
				() =>
					callRoute(
						decline.POST,
						apiRequest(matchUrl(randomUUID(), 'decline'), { method: 'POST' }),
						{ matchId: randomUUID() },
					),
			],
			[
				'POST /api/v1/matches/:id/result',
				() =>
					callRoute(
						result.POST,
						apiRequest(matchUrl(randomUUID(), 'result'), {
							method: 'POST',
							headers: { 'content-type': 'application/json' },
							body: JSON.stringify({ result: 'A' }),
						}),
						{ matchId: randomUUID() },
					),
			],
		])(
			'%s returns 401 in the standard envelope',
			async (_label, makeRequest) => {
				asInvalid();

				const { status, body } = await readJson<ApiErrorBody>(
					await makeRequest(),
				);

				expect(status).toBe(401);
				expect(body.error.code).toBe('unauthorized');
			},
		);
	});

	describe('validation', () => {
		it('confirm: rejects a non-UUID matchId with 400, not a 500', async () => {
			asUser('user_t');
			await createUser(db.prisma, { clerkId: 'user_t' });

			const { status, body } = await readJson<ApiErrorBody>(
				await callRoute(
					confirm.POST,
					apiRequest(matchUrl('not-a-uuid', 'confirm'), { method: 'POST' }),
					{ matchId: 'not-a-uuid' },
				),
			);

			expect(status).toBe(400);
			expect(body.error.code).toBe('bad_request');
		});

		it('result: rejects an invalid result value with 400 from zod, without leaking issues', async () => {
			const { matchId } = await twoUsersMatched('user_u', 'user_v');
			await doConfirm('user_u', matchId);
			await doConfirm('user_v', matchId);

			asUser('user_u');
			const res = await callRoute(
				result.POST,
				apiRequest(matchUrl(matchId, 'result'), {
					method: 'POST',
					headers: { 'content-type': 'application/json' },
					body: JSON.stringify({ result: 'not-a-real-result' }),
				}),
				{ matchId },
			);
			const { status, body } = await readJson<ApiErrorBody>(res);

			expect(status).toBe(400);
			expect(body.error.code).toBe('bad_request');
			expect(body).not.toHaveProperty('issues');
		});

		it('confirm on a genuinely unknown (but well-formed) matchId returns 404', async () => {
			await createUser(db.prisma, { clerkId: 'user_w' });
			asUser('user_w');

			const unknownId = randomUUID();
			const { status, body } = await readJson<ApiErrorBody>(
				await callRoute(
					confirm.POST,
					apiRequest(matchUrl(unknownId, 'confirm'), { method: 'POST' }),
					{ matchId: unknownId },
				),
			);

			expect(status).toBe(404);
			expect(body.error.code).toBe('not_found');
		});
	});
});
