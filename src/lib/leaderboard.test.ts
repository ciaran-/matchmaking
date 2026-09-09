// @vitest-environment node

import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/db', () => ({
	prisma: {
		user: {
			findMany: vi.fn(),
		},
	},
}));

import { prisma } from '@/db';
import { getLeaderboard } from './leaderboard';

const mockFindMany = vi.mocked(prisma.user.findMany);

/** A user row as returned with `include: { gameParticipations: true }`. */
function userRow(
	username: string,
	currentRating: number,
	ratingChanges: number[],
) {
	return {
		id: `id-${username}`,
		username,
		currentRating,
		email: `${username}@test.local`,
		clerkId: `user_${username}`,
		gameParticipations: ratingChanges.map((ratingChange) => ({ ratingChange })),
	};
}

beforeEach(() => {
	vi.clearAllMocks();
});

describe('getLeaderboard', () => {
	it('orders by rating descending and ranks positionally', async () => {
		mockFindMany.mockResolvedValue([
			userRow('ada', 1200, []),
			userRow('grace', 1100, []),
		] as never);

		const rows = await getLeaderboard();

		expect(mockFindMany).toHaveBeenCalledWith({
			orderBy: { currentRating: 'desc' },
			include: { gameParticipations: true },
		});
		expect(rows.map((r) => [r.rank, r.username])).toEqual([
			[1, 'ada'],
			[2, 'grace'],
		]);
	});

	it('derives wins, losses and games played from ratingChange signs', async () => {
		mockFindMany.mockResolvedValue([
			userRow('ada', 1200, [12, -8, 15, -3, 20]),
		] as never);

		const [ada] = await getLeaderboard();

		expect(ada.wins).toBe(3);
		expect(ada.losses).toBe(2);
		expect(ada.gamesPlayed).toBe(5);
	});

	it('counts a draw as neither a win nor a loss', async () => {
		mockFindMany.mockResolvedValue([userRow('ada', 1000, [0, 0, 7])] as never);

		const [ada] = await getLeaderboard();

		expect(ada.wins).toBe(1);
		expect(ada.losses).toBe(0);
		expect(ada.gamesPlayed).toBe(3);
	});

	it('never exposes email or clerkId', async () => {
		mockFindMany.mockResolvedValue([userRow('ada', 1200, [5])] as never);

		const [ada] = await getLeaderboard();

		expect(Object.keys(ada).sort()).toEqual([
			'currentRating',
			'gamesPlayed',
			'id',
			'losses',
			'rank',
			'username',
			'wins',
		]);
		expect(JSON.stringify(ada)).not.toContain('@test.local');
		expect(JSON.stringify(ada)).not.toContain('user_ada');
	});

	it('returns an empty table when there are no users', async () => {
		mockFindMany.mockResolvedValue([] as never);

		await expect(getLeaderboard()).resolves.toEqual([]);
	});
});
