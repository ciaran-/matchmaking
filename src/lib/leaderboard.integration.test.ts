// @vitest-environment node

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from '@/test/db';
import { createGameResult } from '@/test/factories/game-result';
import { createUser } from '@/test/factories/user';
import { getLeaderboard, getPlayerRank } from './leaderboard';
import { pageForRank } from './pagination';

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

async function playGame(
	playerAId: string,
	playerBId: string,
	scores: [number, number],
	changes: [number, number] = [0, 0],
) {
	return createGameResult(db.prisma, {
		teamAScore: scores[0],
		teamBScore: scores[1],
		participants: [
			{
				userId: playerAId,
				team: 'A',
				ratingBefore: 1000,
				ratingAfter: 1000 + changes[0],
				ratingChange: changes[0],
			},
			{
				userId: playerBId,
				team: 'B',
				ratingBefore: 1000,
				ratingAfter: 1000 + changes[1],
				ratingChange: changes[1],
			},
		],
	});
}

describe('getLeaderboard', () => {
	it('returns an empty table when there are no users', async () => {
		await expect(getLeaderboard({}, db.prisma)).resolves.toMatchObject({
			data: [],
			total: 0,
		});
	});

	it('orders by rating, highest first', async () => {
		await createUser(db.prisma, { username: 'low', currentRating: 1000 });
		await createUser(db.prisma, { username: 'top', currentRating: 1200 });
		await createUser(db.prisma, { username: 'mid', currentRating: 1100 });

		const { data: table } = await getLeaderboard({}, db.prisma);

		expect(table.map((r) => r.username)).toEqual(['top', 'mid', 'low']);
		expect(table.map((r) => r.rank)).toEqual([1, 2, 3]);
	});

	it('gives tied players the same rank and skips the next', async () => {
		await createUser(db.prisma, { username: 'top', currentRating: 1200 });
		await createUser(db.prisma, { username: 'tieA', currentRating: 1100 });
		await createUser(db.prisma, { username: 'tieB', currentRating: 1100 });
		await createUser(db.prisma, { username: 'low', currentRating: 1000 });

		const ranks = Object.fromEntries(
			(await getLeaderboard({}, db.prisma)).data.map((r) => [
				r.username,
				r.rank,
			]),
		);

		expect(ranks).toEqual({ top: 1, tieA: 2, tieB: 2, low: 4 });
	});

	it('handles a tie of three or more, which index-based ranking gets wrong', async () => {
		await createUser(db.prisma, { username: 'top', currentRating: 1200 });
		await createUser(db.prisma, { username: 'a', currentRating: 1100 });
		await createUser(db.prisma, { username: 'b', currentRating: 1100 });
		await createUser(db.prisma, { username: 'c', currentRating: 1100 });
		await createUser(db.prisma, { username: 'low', currentRating: 1000 });

		const ranks = Object.fromEntries(
			(await getLeaderboard({}, db.prisma)).data.map((r) => [
				r.username,
				r.rank,
			]),
		);

		expect(ranks).toEqual({ top: 1, a: 2, b: 2, c: 2, low: 5 });
	});

	it('counts wins, losses and draws from the recorded scores', async () => {
		const ada = await createUser(db.prisma, { username: 'ada' });
		const grace = await createUser(db.prisma, { username: 'grace' });

		await playGame(ada.id, grace.id, [1, 0]);
		await playGame(ada.id, grace.id, [0, 1]);
		await playGame(ada.id, grace.id, [0, 0]);

		const { data: table } = await getLeaderboard({}, db.prisma);
		const adaRow = table.find((r) => r.username === 'ada');

		expect(adaRow).toMatchObject({
			wins: 1,
			losses: 1,
			draws: 1,
			gamesPlayed: 3,
		});
	});

	// The bug this replaced: `/api/v1/leaderboard` inferred the outcome
	// from the sign of `ratingChange`, so a drawn game between unequally
	// rated players was reported as a win for one and a loss for the other.
	it('reports a drawn game as a draw for both players, whatever the ratings did', async () => {
		const favourite = await createUser(db.prisma, { username: 'favourite' });
		const underdog = await createUser(db.prisma, { username: 'underdog' });

		await playGame(favourite.id, underdog.id, [0, 0], [-8, 8]);

		const { data: table } = await getLeaderboard({}, db.prisma);

		table.forEach((row) => {
			expect(row).toMatchObject({ wins: 0, losses: 0, draws: 1 });
		});
	});

	it('reports zeroes for a player who has never played', async () => {
		await createUser(db.prisma, { username: 'newbie' });

		const { data } = await getLeaderboard({}, db.prisma);
		const row = data[0];

		expect(row).toMatchObject({
			wins: 0,
			losses: 0,
			draws: 0,
			gamesPlayed: 0,
		});
	});

	it('never exposes email or clerkId', async () => {
		await createUser(db.prisma, { username: 'ada', clerkId: 'user_ada' });

		const { data } = await getLeaderboard({}, db.prisma);
		const row = data[0];

		expect(Object.keys(row).sort()).toEqual([
			'currentRating',
			'draws',
			'gamesPlayed',
			'id',
			'losses',
			'rank',
			'username',
			'wins',
		]);
	});

	describe('pagination', () => {
		/** `count` players at descending ratings, so ranks are unambiguous. */
		async function ladder(count: number) {
			const names = Array.from({ length: count }, (_, i) => `p${i + 1}`);
			await names.reduce(
				(chain, name, i) =>
					chain.then(() =>
						createUser(db.prisma, {
							username: name,
							currentRating: 2000 - i,
						}).then(() => undefined),
					),
				Promise.resolve(),
			);
			return names;
		}

		it('returns the requested page and reports the total', async () => {
			await ladder(7);

			const page = await getLeaderboard({ page: 2, pageSize: 3 }, db.prisma);

			expect(page.data.map((r) => r.username)).toEqual(['p4', 'p5', 'p6']);
			expect(page).toMatchObject({ page: 2, pageSize: 3, total: 7 });
		});

		it('keeps rank absolute across pages, not relative to the page', async () => {
			await ladder(7);

			const page = await getLeaderboard({ page: 3, pageSize: 3 }, db.prisma);

			// p7 is 7th in the league, not 1st on its page.
			expect(page.data.map((r) => r.rank)).toEqual([7]);
		});

		it('keeps tied ranks consistent when the tie spans a page boundary', async () => {
			// Four players level on 1100: ranks 1,1,1,1 — the tie straddles
			// the split, which `offset + index + 1` would get wrong on the
			// second page.
			await createUser(db.prisma, { username: 'a', currentRating: 1100 });
			await createUser(db.prisma, { username: 'b', currentRating: 1100 });
			await createUser(db.prisma, { username: 'c', currentRating: 1100 });
			await createUser(db.prisma, { username: 'd', currentRating: 1100 });

			const first = await getLeaderboard({ page: 1, pageSize: 2 }, db.prisma);
			const second = await getLeaderboard({ page: 2, pageSize: 2 }, db.prisma);

			expect(first.data.map((r) => r.rank)).toEqual([1, 1]);
			expect(second.data.map((r) => r.rank)).toEqual([1, 1]);
		});

		it('returns an empty page rather than erroring past the end', async () => {
			await ladder(3);

			const page = await getLeaderboard({ page: 99, pageSize: 10 }, db.prisma);

			expect(page.data).toEqual([]);
			expect(page.total).toBe(3);
		});

		it('clamps nonsense page and pageSize values', async () => {
			await ladder(3);

			const page = await getLeaderboard(
				{ page: 0, pageSize: 100_000 },
				db.prisma,
			);

			expect(page.page).toBe(1);
			expect(page.pageSize).toBeLessThanOrEqual(100);
			expect(page.data).toHaveLength(3);
		});
	});

	describe('search', () => {
		beforeEach(async () => {
			await createUser(db.prisma, { username: 'ada', currentRating: 1300 });
			await createUser(db.prisma, {
				username: 'adalovelace',
				currentRating: 1200,
			});
			await createUser(db.prisma, { username: 'grace', currentRating: 1100 });
		});

		it('matches a case-insensitive substring', async () => {
			const page = await getLeaderboard({ search: 'ADA' }, db.prisma);

			expect(page.data.map((r) => r.username).sort()).toEqual([
				'ada',
				'adalovelace',
			]);
			expect(page.total).toBe(2);
		});

		it('reports league rank, not rank among the search results', async () => {
			const page = await getLeaderboard({ search: 'grace' }, db.prisma);

			// grace is 3rd in the league; searching must not renumber her 1st.
			expect(page.data[0]).toMatchObject({ username: 'grace', rank: 3 });
		});

		it('treats LIKE wildcards as literal characters', async () => {
			// '%' would otherwise match everything, and '_' any single char.
			const percent = await getLeaderboard({ search: '%' }, db.prisma);
			const underscore = await getLeaderboard({ search: 'a_a' }, db.prisma);

			expect(percent.data).toEqual([]);
			expect(underscore.data).toEqual([]);
		});

		it('ignores surrounding whitespace', async () => {
			const page = await getLeaderboard({ search: '  grace  ' }, db.prisma);

			expect(page.data).toHaveLength(1);
		});

		it('returns the whole table for an empty search', async () => {
			const page = await getLeaderboard({ search: '   ' }, db.prisma);

			expect(page.total).toBe(3);
		});
	});

	describe('getPlayerRank', () => {
		it('matches the rank the table reports', async () => {
			await createUser(db.prisma, { username: 'top', currentRating: 1200 });
			const mid = await createUser(db.prisma, {
				username: 'mid',
				currentRating: 1100,
			});

			const { data } = await getLeaderboard({}, db.prisma);
			const fromTable = data.find((r) => r.username === 'mid')?.rank;

			await expect(getPlayerRank(mid.id, db.prisma)).resolves.toBe(fromTable);
		});

		it('returns null for an unknown user', async () => {
			await expect(getPlayerRank('nope', db.prisma)).resolves.toBeNull();
		});
	});
});

describe('pageForRank', () => {
	it('puts the first page ranks on page 1', () => {
		expect(pageForRank(1, 25)).toBe(1);
		expect(pageForRank(25, 25)).toBe(1);
	});

	it('rolls over exactly at the boundary', () => {
		expect(pageForRank(26, 25)).toBe(2);
		expect(pageForRank(50, 25)).toBe(2);
		expect(pageForRank(51, 25)).toBe(3);
	});

	it('never returns page 0', () => {
		expect(pageForRank(0, 25)).toBe(1);
	});
});
