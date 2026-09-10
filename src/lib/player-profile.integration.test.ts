// @vitest-environment node

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from '@/test/db';
import { createGameResult } from '@/test/factories/game-result';
import { createUser } from '@/test/factories/user';
import { getPlayerProfile } from './player-profile';

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

/**
 * A finished game between two players.
 *
 * `ratingChange` is set deliberately at odds with the score in some tests
 * below, to prove the outcome is read from the score and not from the
 * rating movement.
 */
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

describe('getPlayerProfile', () => {
	it('returns null for an unknown username', async () => {
		await expect(getPlayerProfile('nobody', db.prisma)).resolves.toBeNull();
	});

	it('returns identity and zeroed counts for a player with no games', async () => {
		const user = await createUser(db.prisma, {
			username: 'newbie',
			currentRating: 1000,
		});

		const profile = await getPlayerProfile('newbie', db.prisma);

		expect(profile).toMatchObject({
			id: user.id,
			username: 'newbie',
			currentRating: 1000,
			wins: 0,
			losses: 0,
			draws: 0,
			gamesPlayed: 0,
		});
		expect(profile?.memberSince).toBe(user.createdAt.toISOString());
	});

	it('counts wins, losses and draws from the recorded scores', async () => {
		const player = await createUser(db.prisma, { username: 'ada' });
		const opponent = await createUser(db.prisma, { username: 'grace' });

		await playGame(player.id, opponent.id, [1, 0]); // win
		await playGame(player.id, opponent.id, [1, 0]); // win
		await playGame(player.id, opponent.id, [0, 1]); // loss
		await playGame(player.id, opponent.id, [0, 0]); // draw

		const profile = await getPlayerProfile('ada', db.prisma);

		expect(profile).toMatchObject({
			wins: 2,
			losses: 1,
			draws: 1,
			gamesPlayed: 4,
		});
	});

	it('counts the same games correctly from the other side', async () => {
		const player = await createUser(db.prisma, { username: 'ada' });
		const opponent = await createUser(db.prisma, { username: 'grace' });

		await playGame(player.id, opponent.id, [1, 0]);
		await playGame(player.id, opponent.id, [0, 1]);
		await playGame(player.id, opponent.id, [0, 0]);

		const profile = await getPlayerProfile('grace', db.prisma);

		expect(profile).toMatchObject({
			wins: 1,
			losses: 1,
			draws: 1,
			gamesPlayed: 3,
		});
	});

	// The regression that prompted this module. A draw between unequally
	// rated players moves both ratings, so classifying by `ratingChange`
	// scored it as a win for the underdog and a loss for the favourite.
	it('counts a drawn game as a draw even when both ratings moved', async () => {
		const favourite = await createUser(db.prisma, { username: 'favourite' });
		const underdog = await createUser(db.prisma, { username: 'underdog' });

		// 0-0 is a draw; Elo still moved the favourite down and the
		// underdog up, exactly as it does at unequal ratings.
		await playGame(favourite.id, underdog.id, [0, 0], [-8, 8]);

		const favouriteProfile = await getPlayerProfile('favourite', db.prisma);
		const underdogProfile = await getPlayerProfile('underdog', db.prisma);

		expect(favouriteProfile).toMatchObject({
			wins: 0,
			losses: 0,
			draws: 1,
		});
		expect(underdogProfile).toMatchObject({
			wins: 0,
			losses: 0,
			draws: 1,
		});
	});

	it('ignores games the player was not in', async () => {
		await createUser(db.prisma, { username: 'ada' });
		const other1 = await createUser(db.prisma, { username: 'x' });
		const other2 = await createUser(db.prisma, { username: 'y' });

		await playGame(other1.id, other2.id, [1, 0]);

		const profile = await getPlayerProfile('ada', db.prisma);

		expect(profile?.gamesPlayed).toBe(0);
	});

	describe('rank', () => {
		it('is 1-based, by rating descending', async () => {
			await createUser(db.prisma, { username: 'top', currentRating: 1200 });
			await createUser(db.prisma, { username: 'mid', currentRating: 1100 });
			await createUser(db.prisma, { username: 'low', currentRating: 1000 });

			expect((await getPlayerProfile('top', db.prisma))?.rank).toBe(1);
			expect((await getPlayerProfile('mid', db.prisma))?.rank).toBe(2);
			expect((await getPlayerProfile('low', db.prisma))?.rank).toBe(3);
		});

		it('gives tied players the same rank, and skips the next', async () => {
			await createUser(db.prisma, { username: 'top', currentRating: 1200 });
			await createUser(db.prisma, { username: 'tieA', currentRating: 1100 });
			await createUser(db.prisma, { username: 'tieB', currentRating: 1100 });
			await createUser(db.prisma, { username: 'low', currentRating: 1000 });

			// Standard competition ranking: 1, 2, 2, 4.
			expect((await getPlayerProfile('tieA', db.prisma))?.rank).toBe(2);
			expect((await getPlayerProfile('tieB', db.prisma))?.rank).toBe(2);
			expect((await getPlayerProfile('low', db.prisma))?.rank).toBe(4);
		});
	});
});
