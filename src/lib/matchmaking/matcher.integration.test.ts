// @vitest-environment node

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from '@/test/db';
import {
	appendSearchEvent,
	createStartedSearch,
} from '@/test/factories/matchmaking-events';
import { createUser } from '@/test/factories/user';
import { twoSearchingPlayersAtEqualRating } from '@/test/scenarios';
import { findMatchFor } from './matcher';
import { getActiveSearchForUser, getSearchAttempt } from './state';

let db: TestDatabase;

beforeAll(async () => {
	db = await createTestDatabase();
}, 120_000);

beforeEach(async () => {
	await db.reset();
});

afterAll(async () => {
	await db.teardown();
});

describe('findMatchFor', () => {
	it('returns null when no other searches exist', async () => {
		const user = await createUser(db.prisma, { currentRating: 1000 });
		await createStartedSearch(db.prisma, user);

		const search = await getActiveSearchForUser(user.id);
		if (!search) throw new Error('expected active search');

		const match = await findMatchFor(search);
		expect(match).toBeNull();
	});

	it('pairs two equal-rated fresh searches', async () => {
		const { playerA, playerB } = await twoSearchingPlayersAtEqualRating(
			db.prisma,
		);

		const searchA = await getActiveSearchForUser(playerA.id);
		if (!searchA) throw new Error('expected active search for A');

		const match = await findMatchFor(searchA);
		expect(match).not.toBeNull();
		expect(match?.userId).toBe(playerB.id);
	});

	it('does NOT pair players outside base tolerance at t=0', async () => {
		// Base tolerance is 50, so 1000 vs 1500 is far outside the band at t=0.
		const playerA = await createUser(db.prisma, { currentRating: 1000 });
		const playerB = await createUser(db.prisma, { currentRating: 1500 });
		await createStartedSearch(db.prisma, playerA);
		await createStartedSearch(db.prisma, playerB);

		const searchA = await getActiveSearchForUser(playerA.id);
		if (!searchA) throw new Error('expected active search for A');

		const match = await findMatchFor(searchA);
		expect(match).toBeNull();
	});

	it('pairs the same two players when both have waited long enough to widen', async () => {
		// At t=0, base tolerance 50 would not allow a 1000 vs 1100 pair (delta 100).
		// After both have waited 6 seconds: tolerance = 50 + 10*6 = 110, so 1100
		// falls inside A's band [890, 1110] and 1000 falls inside B's band [990, 1210].
		const playerA = await createUser(db.prisma, { currentRating: 1000 });
		const playerB = await createUser(db.prisma, { currentRating: 1100 });

		const fixedNow = new Date('2026-01-01T12:00:00Z');
		const sixSecondsAgo = new Date(fixedNow.getTime() - 6_000);

		await createStartedSearch(db.prisma, playerA, {
			createdAt: sixSecondsAgo,
		});
		await createStartedSearch(db.prisma, playerB, {
			createdAt: sixSecondsAgo,
		});

		const searchA = await getActiveSearchForUser(playerA.id);
		if (!searchA) throw new Error('expected active search for A');

		// Confirm no match at t=0 (band is base = 50).
		const matchAtFresh = await findMatchFor(searchA, searchA.startedAt);
		expect(matchAtFresh).toBeNull();

		// Match exists once the band has widened.
		const matchAtSix = await findMatchFor(searchA, fixedNow);
		expect(matchAtSix).not.toBeNull();
		expect(matchAtSix?.userId).toBe(playerB.id);
	});

	it('prefers the closer-rated candidate when multiple are in range', async () => {
		const searcher = await createUser(db.prisma, { currentRating: 1000 });
		const closer = await createUser(db.prisma, { currentRating: 1020 });
		const further = await createUser(db.prisma, { currentRating: 1045 });

		await createStartedSearch(db.prisma, searcher);
		await createStartedSearch(db.prisma, closer);
		await createStartedSearch(db.prisma, further);

		const search = await getActiveSearchForUser(searcher.id);
		if (!search) throw new Error('expected active search');

		const match = await findMatchFor(search);
		expect(match).not.toBeNull();
		expect(match?.userId).toBe(closer.id);
	});

	it('breaks ties by longest-waiting (oldest startedAt) first', async () => {
		// Two candidates equally far from the searcher; the older one wins.
		const fixedNow = new Date('2026-01-01T12:00:00Z');
		const searcher = await createUser(db.prisma, { currentRating: 1000 });
		const recentOpponent = await createUser(db.prisma, {
			currentRating: 1020,
		});
		const olderOpponent = await createUser(db.prisma, { currentRating: 1020 });

		await createStartedSearch(db.prisma, searcher, { createdAt: fixedNow });
		await createStartedSearch(db.prisma, recentOpponent, {
			createdAt: new Date(fixedNow.getTime() - 1_000),
		});
		await createStartedSearch(db.prisma, olderOpponent, {
			createdAt: new Date(fixedNow.getTime() - 5_000),
		});

		const search = await getActiveSearchForUser(searcher.id);
		if (!search) throw new Error('expected active search');

		const match = await findMatchFor(search, fixedNow);
		expect(match).not.toBeNull();
		expect(match?.userId).toBe(olderOpponent.id);
	});

	it('enforces symmetric tolerance — a fresh narrow search ignores an old wide search outside its fresh band', async () => {
		// Old wide candidate at rating 1300, has waited ~30s → band 1300 ± 350
		// (= 950..1650), which DOES include 1000.
		// Fresh narrow searcher at rating 1000, has waited 0s → band 1000 ± 50
		// (= 950..1050), which does NOT include 1300.
		// Symmetric tolerance must reject the pair: the fresh side rules out
		// the candidate even though the wide side would accept.
		const fixedNow = new Date('2026-01-01T12:00:00Z');
		const fresh = await createUser(db.prisma, { currentRating: 1000 });
		const old = await createUser(db.prisma, { currentRating: 1300 });

		await createStartedSearch(db.prisma, fresh, { createdAt: fixedNow });
		await createStartedSearch(db.prisma, old, {
			createdAt: new Date(fixedNow.getTime() - 30_000),
		});

		const searchFresh = await getActiveSearchForUser(fresh.id);
		if (!searchFresh) throw new Error('expected fresh search');

		const matchForFresh = await findMatchFor(searchFresh, fixedNow);
		expect(matchForFresh).toBeNull();

		// And the converse: the old wide search would accept the fresh narrow
		// rating, but symmetric-tolerance rules out the pair because the fresh
		// side's tight band doesn't include the old rating.
		const searchOld = await getActiveSearchForUser(old.id);
		if (!searchOld) throw new Error('expected old search');

		const matchForOld = await findMatchFor(searchOld, fixedNow);
		expect(matchForOld).toBeNull();
	});

	it('does not return the searcher themselves', async () => {
		const user = await createUser(db.prisma, { currentRating: 1000 });
		await createStartedSearch(db.prisma, user);

		const search = await getActiveSearchForUser(user.id);
		if (!search) throw new Error('expected active search');

		const match = await findMatchFor(search);
		expect(match).toBeNull();
	});

	it('excludes candidates whose latest event is no longer STARTED (MATCHED)', async () => {
		const playerA = await createUser(db.prisma, { currentRating: 1000 });
		const playerB = await createUser(db.prisma, { currentRating: 1000 });
		const fixedNow = new Date('2026-01-01T12:00:00Z');
		await createStartedSearch(db.prisma, playerA, { createdAt: fixedNow });
		const searchB = await createStartedSearch(db.prisma, playerB, {
			createdAt: fixedNow,
		});
		// playerB's search has progressed past STARTED — not a candidate.
		await appendSearchEvent(db.prisma, searchB.attemptId, 'MATCHED', {
			matchId: 'm-existing',
			createdAt: new Date(fixedNow.getTime() + 1_000),
		});

		const searchA = await getActiveSearchForUser(playerA.id);
		if (!searchA) throw new Error('expected active search for A');

		const match = await findMatchFor(searchA, fixedNow);
		expect(match).toBeNull();
	});

	it('excludes candidates whose latest event is terminal (CANCELLED)', async () => {
		// Use explicit timestamps so the CANCELLED is unambiguously later than
		// the STARTED — same-millisecond collisions otherwise make the
		// DISTINCT-ON ordering for the attempt undefined.
		const playerA = await createUser(db.prisma, { currentRating: 1000 });
		const playerB = await createUser(db.prisma, { currentRating: 1000 });
		const fixedNow = new Date('2026-01-01T12:00:00Z');
		await createStartedSearch(db.prisma, playerA, { createdAt: fixedNow });
		const searchB = await createStartedSearch(db.prisma, playerB, {
			createdAt: fixedNow,
		});
		await appendSearchEvent(db.prisma, searchB.attemptId, 'CANCELLED', {
			createdAt: new Date(fixedNow.getTime() + 1_000),
		});

		const searchA = await getActiveSearchForUser(playerA.id);
		if (!searchA) throw new Error('expected active search for A');

		const match = await findMatchFor(searchA, fixedNow);
		expect(match).toBeNull();
	});

	it('does not crash when called with a search whose own state is no longer STARTED', async () => {
		// Sanity check: the matcher's input is a `DerivedSearchState`, not a
		// promise to fetch it. Callers are expected to gate on the input
		// search's own state separately — this test merely confirms the
		// matcher returns a sensible candidate (or null) without crashing
		// on a non-STARTED input.
		const fixedNow = new Date('2026-01-01T12:00:00Z');
		const playerA = await createUser(db.prisma, { currentRating: 1000 });
		const playerB = await createUser(db.prisma, { currentRating: 1000 });
		const searchA = await createStartedSearch(db.prisma, playerA, {
			createdAt: fixedNow,
		});
		await createStartedSearch(db.prisma, playerB, { createdAt: fixedNow });
		await appendSearchEvent(db.prisma, searchA.attemptId, 'CANCELLED', {
			createdAt: new Date(fixedNow.getTime() + 1_000),
		});

		const cancelledSearch = await getSearchAttempt(searchA.attemptId);
		if (!cancelledSearch) throw new Error('expected attempt');

		const match = await findMatchFor(cancelledSearch, fixedNow);
		// The cancelled searcher could still be matched against playerB's
		// active STARTED search per the algorithm; verify it returns playerB
		// rather than crashing, so callers can rely on a defined contract.
		expect(match).not.toBeNull();
		expect(match?.userId).toBe(playerB.id);
	});
});
