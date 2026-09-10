// @vitest-environment node

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from '@/test/db';
import { createGameResult } from '@/test/factories/game-result';
import { createUser } from '@/test/factories/user';
import { getPlayerMatchHistory } from './player-match-history';

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
 * A finished 1v1 game between two players.
 *
 * `changes` can be set at odds with `scores`, exactly like
 * `player-profile.integration.test.ts`, to prove outcome comes from the
 * score and not from `ratingChange`.
 */
async function playGame(
	playerAId: string,
	playerBId: string,
	scores: [number, number],
	opts: { changes?: [number, number]; createdAt?: Date } = {},
) {
	const changes = opts.changes ?? [0, 0];
	return createGameResult(db.prisma, {
		teamAScore: scores[0],
		teamBScore: scores[1],
		createdAt: opts.createdAt,
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

describe('getPlayerMatchHistory', () => {
	it('returns null for an unknown username', async () => {
		await expect(
			getPlayerMatchHistory('nobody', {}, db.prisma),
		).resolves.toBeNull();
	});

	it('returns an empty page for a player with no games', async () => {
		await createUser(db.prisma, { username: 'newbie' });

		const page = await getPlayerMatchHistory('newbie', {}, db.prisma);

		expect(page).toEqual({ data: [], nextCursor: null });
	});

	it('reports opponent, outcome, rating movement and mode for a win', async () => {
		const player = await createUser(db.prisma, { username: 'ada' });
		const opponent = await createUser(db.prisma, { username: 'grace' });

		await playGame(player.id, opponent.id, [1, 0], { changes: [16, -16] });

		const page = await getPlayerMatchHistory('ada', {}, db.prisma);

		expect(page?.data).toHaveLength(1);
		expect(page?.data[0]).toMatchObject({
			opponentUsername: 'grace',
			outcome: 'win',
			ratingChange: 16,
			ratingAfter: 1016,
			mode: 'ONE_VS_ONE',
		});
		expect(page?.data[0].gameResultId).toBeTruthy();
		expect(page?.data[0].playedAt).toEqual(expect.any(String));
	});

	it('resolves the opponent correctly from either side of the same game', async () => {
		const ada = await createUser(db.prisma, { username: 'ada' });
		const grace = await createUser(db.prisma, { username: 'grace' });

		await playGame(ada.id, grace.id, [1, 0]);

		const adaPage = await getPlayerMatchHistory('ada', {}, db.prisma);
		const gracePage = await getPlayerMatchHistory('grace', {}, db.prisma);

		expect(adaPage?.data[0]).toMatchObject({
			opponentUsername: 'grace',
			outcome: 'win',
		});
		expect(gracePage?.data[0]).toMatchObject({
			opponentUsername: 'ada',
			outcome: 'loss',
		});
	});

	// The regression `game-outcome.ts` exists to prevent: a draw between
	// unequally rated players still moves both ratings, so classifying by
	// the sign of `ratingChange` would report it as a win/loss instead.
	it('reports a drawn game as a draw even when both ratings moved', async () => {
		const favourite = await createUser(db.prisma, { username: 'favourite' });
		const underdog = await createUser(db.prisma, { username: 'underdog' });

		await playGame(favourite.id, underdog.id, [0, 0], {
			changes: [-8, 8],
		});

		const favouritePage = await getPlayerMatchHistory(
			'favourite',
			{},
			db.prisma,
		);
		const underdogPage = await getPlayerMatchHistory('underdog', {}, db.prisma);

		expect(favouritePage?.data[0]).toMatchObject({
			outcome: 'draw',
			ratingChange: -8,
		});
		expect(underdogPage?.data[0]).toMatchObject({
			outcome: 'draw',
			ratingChange: 8,
		});
	});

	it('orders games newest first', async () => {
		const player = await createUser(db.prisma, { username: 'ada' });
		const opponent = await createUser(db.prisma, { username: 'grace' });

		await playGame(player.id, opponent.id, [1, 0], {
			createdAt: new Date('2026-01-01T00:00:00Z'),
		});
		await playGame(player.id, opponent.id, [1, 0], {
			createdAt: new Date('2026-01-03T00:00:00Z'),
		});
		await playGame(player.id, opponent.id, [1, 0], {
			createdAt: new Date('2026-01-02T00:00:00Z'),
		});

		const page = await getPlayerMatchHistory('ada', {}, db.prisma);

		expect(page?.data.map((r) => r.playedAt)).toEqual([
			new Date('2026-01-03T00:00:00Z').toISOString(),
			new Date('2026-01-02T00:00:00Z').toISOString(),
			new Date('2026-01-01T00:00:00Z').toISOString(),
		]);
	});

	it('ignores games the player was not in', async () => {
		await createUser(db.prisma, { username: 'ada' });
		const other1 = await createUser(db.prisma, { username: 'x' });
		const other2 = await createUser(db.prisma, { username: 'y' });

		await playGame(other1.id, other2.id, [1, 0]);

		const page = await getPlayerMatchHistory('ada', {}, db.prisma);

		expect(page?.data).toEqual([]);
	});

	it('excludes TEAM_VS_TEAM games entirely rather than guessing an opponent', async () => {
		const player = await createUser(db.prisma, { username: 'ada' });
		const opponent = await createUser(db.prisma, { username: 'grace' });

		await createGameResult(db.prisma, {
			mode: 'TEAM_VS_TEAM',
			teamAScore: 1,
			teamBScore: 0,
			participants: [
				{
					userId: player.id,
					team: 'A',
					ratingBefore: 1000,
					ratingAfter: 1010,
					ratingChange: 10,
				},
				{
					userId: opponent.id,
					team: 'B',
					ratingBefore: 1000,
					ratingAfter: 990,
					ratingChange: -10,
				},
			],
		});
		await playGame(player.id, opponent.id, [1, 0]); // ONE_VS_ONE

		const page = await getPlayerMatchHistory('ada', {}, db.prisma);

		expect(page?.data).toHaveLength(1);
		expect(page?.data[0].mode).toBe('ONE_VS_ONE');
	});

	describe('pagination', () => {
		async function playN(playerId: string, opponentId: string, n: number) {
			// Distinct timestamps, oldest first as created, so the newest
			// (highest index) sorts first.
			for (let i = 0; i < n; i++) {
				await playGame(playerId, opponentId, [1, 0], {
					createdAt: new Date(2026, 0, 1 + i),
				});
			}
		}

		it('respects the limit and returns a nextCursor when more remain', async () => {
			const player = await createUser(db.prisma, { username: 'ada' });
			const opponent = await createUser(db.prisma, { username: 'grace' });
			await playN(player.id, opponent.id, 5);

			const page = await getPlayerMatchHistory('ada', { limit: 2 }, db.prisma);

			expect(page?.data).toHaveLength(2);
			expect(page?.nextCursor).not.toBeNull();
			// Newest two: day 5 then day 4.
			expect(page?.data.map((r) => r.playedAt)).toEqual([
				new Date(2026, 0, 5).toISOString(),
				new Date(2026, 0, 4).toISOString(),
			]);
		});

		it('walks through every game exactly once via nextCursor, with null on the last page', async () => {
			const player = await createUser(db.prisma, { username: 'ada' });
			const opponent = await createUser(db.prisma, { username: 'grace' });
			await playN(player.id, opponent.id, 5);

			const seen: string[] = [];
			let cursor: string | undefined;
			for (let guard = 0; guard < 10; guard++) {
				const page = await getPlayerMatchHistory(
					'ada',
					{ limit: 2, cursor },
					db.prisma,
				);
				if (!page) throw new Error('expected a page');
				seen.push(...page.data.map((r) => r.gameResultId));
				if (!page.nextCursor) break;
				cursor = page.nextCursor;
			}

			expect(seen).toHaveLength(5);
			expect(new Set(seen).size).toBe(5); // no duplicates, nothing skipped
		});

		it('breaks ties on gameResultId when two games share a createdAt', async () => {
			const player = await createUser(db.prisma, { username: 'ada' });
			const opponent = await createUser(db.prisma, { username: 'grace' });
			const shared = new Date('2026-01-01T00:00:00Z');

			const a = await playGame(player.id, opponent.id, [1, 0], {
				createdAt: shared,
			});
			const b = await playGame(player.id, opponent.id, [1, 0], {
				createdAt: shared,
			});
			const expectedOrder = [a.id, b.id].sort().reverse(); // id DESC tiebreak

			const first = await getPlayerMatchHistory('ada', { limit: 1 }, db.prisma);
			expect(first?.data[0].gameResultId).toBe(expectedOrder[0]);
			expect(first?.nextCursor).not.toBeNull();

			const second = await getPlayerMatchHistory(
				'ada',
				{ limit: 1, cursor: first?.nextCursor ?? undefined },
				db.prisma,
			);
			expect(second?.data[0].gameResultId).toBe(expectedOrder[1]);
			expect(second?.nextCursor).toBeNull();
		});

		it('throws for a cursor that does not decode', async () => {
			await createUser(db.prisma, { username: 'ada' });

			await expect(
				getPlayerMatchHistory(
					'ada',
					{ cursor: 'not-a-real-cursor' },
					db.prisma,
				),
			).rejects.toThrow('Invalid cursor');
		});

		it('clamps an out-of-range limit into [1, 50]', async () => {
			const player = await createUser(db.prisma, { username: 'ada' });
			const opponent = await createUser(db.prisma, { username: 'grace' });
			await playN(player.id, opponent.id, 3);

			const page = await getPlayerMatchHistory(
				'ada',
				{ limit: 1000 },
				db.prisma,
			);

			expect(page?.data).toHaveLength(3);
			expect(page?.nextCursor).toBeNull();
		});
	});
});
