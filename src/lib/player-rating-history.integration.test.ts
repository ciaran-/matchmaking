// @vitest-environment node

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from '@/test/db';
import { createGameResult } from '@/test/factories/game-result';
import { createUser } from '@/test/factories/user';
import { getPlayerRatingHistory } from './player-rating-history';

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

/** A finished game between two players, with a controllable timestamp. */
async function playGame(
	playerAId: string,
	playerBId: string,
	changes: [number, number],
	createdAt: Date,
) {
	return createGameResult(db.prisma, {
		createdAt,
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

describe('getPlayerRatingHistory', () => {
	it('returns null for an unknown username', async () => {
		await expect(
			getPlayerRatingHistory('nobody', db.prisma),
		).resolves.toBeNull();
	});

	it('returns an empty array for a player with no games', async () => {
		await createUser(db.prisma, { username: 'newbie' });

		await expect(getPlayerRatingHistory('newbie', db.prisma)).resolves.toEqual(
			[],
		);
	});

	it('returns a single point for a player with one game', async () => {
		const player = await createUser(db.prisma, { username: 'ada' });
		const opponent = await createUser(db.prisma, { username: 'grace' });

		const game = await playGame(
			player.id,
			opponent.id,
			[16, -16],
			new Date('2026-01-01T00:00:00.000Z'),
		);

		const history = await getPlayerRatingHistory('ada', db.prisma);

		expect(history).toEqual([
			{
				rating: 1016,
				at: '2026-01-01T00:00:00.000Z',
				gameResultId: game.id,
			},
		]);
	});

	it('orders points ascending by game time, not insertion order', async () => {
		const player = await createUser(db.prisma, { username: 'ada' });
		const opponent = await createUser(db.prisma, { username: 'grace' });

		// Inserted out of chronological order on purpose.
		const second = await playGame(
			player.id,
			opponent.id,
			[8, -8],
			new Date('2026-01-02T00:00:00.000Z'),
		);
		const first = await playGame(
			player.id,
			opponent.id,
			[16, -16],
			new Date('2026-01-01T00:00:00.000Z'),
		);
		const third = await playGame(
			player.id,
			opponent.id,
			[-4, 4],
			new Date('2026-01-03T00:00:00.000Z'),
		);

		const history = await getPlayerRatingHistory('ada', db.prisma);

		expect(history?.map((p) => p.gameResultId)).toEqual([
			first.id,
			second.id,
			third.id,
		]);
		expect(history?.map((p) => p.rating)).toEqual([1016, 1008, 996]);
	});

	it('ignores games the player was not in', async () => {
		await createUser(db.prisma, { username: 'ada' });
		const other1 = await createUser(db.prisma, { username: 'x' });
		const other2 = await createUser(db.prisma, { username: 'y' });

		await playGame(other1.id, other2.id, [16, -16], new Date());

		await expect(getPlayerRatingHistory('ada', db.prisma)).resolves.toEqual([]);
	});

	it("reads the player's own ratingAfter, not the opponent's", async () => {
		const player = await createUser(db.prisma, { username: 'ada' });
		const opponent = await createUser(db.prisma, { username: 'grace' });

		await playGame(player.id, opponent.id, [16, -16], new Date());

		const [adaHistory, graceHistory] = await Promise.all([
			getPlayerRatingHistory('ada', db.prisma),
			getPlayerRatingHistory('grace', db.prisma),
		]);

		expect(adaHistory?.[0]?.rating).toBe(1016);
		expect(graceHistory?.[0]?.rating).toBe(984);
	});
});
