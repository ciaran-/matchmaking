// @vitest-environment node

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from '@/test/db';
import { createGameResult } from '@/test/factories/game-result';
import { createUser } from '@/test/factories/user';
import { getLeaderboard } from './leaderboard';

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
		await expect(getLeaderboard(db.prisma)).resolves.toEqual([]);
	});

	it('orders by rating, highest first', async () => {
		await createUser(db.prisma, { username: 'low', currentRating: 1000 });
		await createUser(db.prisma, { username: 'top', currentRating: 1200 });
		await createUser(db.prisma, { username: 'mid', currentRating: 1100 });

		const table = await getLeaderboard(db.prisma);

		expect(table.map((r) => r.username)).toEqual(['top', 'mid', 'low']);
		expect(table.map((r) => r.rank)).toEqual([1, 2, 3]);
	});

	it('gives tied players the same rank and skips the next', async () => {
		await createUser(db.prisma, { username: 'top', currentRating: 1200 });
		await createUser(db.prisma, { username: 'tieA', currentRating: 1100 });
		await createUser(db.prisma, { username: 'tieB', currentRating: 1100 });
		await createUser(db.prisma, { username: 'low', currentRating: 1000 });

		const ranks = Object.fromEntries(
			(await getLeaderboard(db.prisma)).map((r) => [r.username, r.rank]),
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
			(await getLeaderboard(db.prisma)).map((r) => [r.username, r.rank]),
		);

		expect(ranks).toEqual({ top: 1, a: 2, b: 2, c: 2, low: 5 });
	});

	it('counts wins, losses and draws from the recorded scores', async () => {
		const ada = await createUser(db.prisma, { username: 'ada' });
		const grace = await createUser(db.prisma, { username: 'grace' });

		await playGame(ada.id, grace.id, [1, 0]);
		await playGame(ada.id, grace.id, [0, 1]);
		await playGame(ada.id, grace.id, [0, 0]);

		const table = await getLeaderboard(db.prisma);
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

		const table = await getLeaderboard(db.prisma);

		table.forEach((row) => {
			expect(row).toMatchObject({ wins: 0, losses: 0, draws: 1 });
		});
	});

	it('reports zeroes for a player who has never played', async () => {
		await createUser(db.prisma, { username: 'newbie' });

		const [row] = await getLeaderboard(db.prisma);

		expect(row).toMatchObject({
			wins: 0,
			losses: 0,
			draws: 0,
			gamesPlayed: 0,
		});
	});

	it('never exposes email or clerkId', async () => {
		await createUser(db.prisma, { username: 'ada', clerkId: 'user_ada' });

		const [row] = await getLeaderboard(db.prisma);

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
});
