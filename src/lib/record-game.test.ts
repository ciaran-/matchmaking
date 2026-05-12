// @vitest-environment node

import { beforeEach, describe, expect, it, vi } from 'vitest';

// ---------- Mocks ----------

vi.mock('@/db', () => ({
	prisma: {
		user: { findMany: vi.fn(), update: vi.fn() },
		gameResult: { create: vi.fn() },
		$transaction: vi.fn(),
	},
}));

vi.mock('@sentry/tanstackstart-react', () => ({
	startSpan: vi.fn((_opts: unknown, fn: () => unknown) => fn()),
}));

import { prisma } from '@/db';
import { recordGame } from './record-game';

const mockFindMany = vi.mocked(prisma.user.findMany);
const mockCreate = vi.mocked(prisma.gameResult.create);
const mockUpdate = vi.mocked(prisma.user.update);
const mockTransaction = vi.mocked(prisma.$transaction);

// ---------- Setup ----------

beforeEach(() => {
	vi.clearAllMocks();

	mockFindMany.mockResolvedValue([
		{ id: 'player-a', username: 'alice', currentRating: 1000 } as never,
		{ id: 'player-b', username: 'bob', currentRating: 1000 } as never,
	]);

	mockCreate.mockResolvedValue({
		id: 'game-1',
		mode: 'ONE_VS_ONE',
		teamAScore: 1,
		teamBScore: 0,
		createdAt: new Date(),
	} as never);

	mockUpdate.mockResolvedValue({} as never);

	// Execute the transaction ops array
	mockTransaction.mockImplementation(
		(ops: Promise<unknown>[]) => Promise.all(ops) as never,
	);
});

// ---------- Helpers ----------

type Participant = {
	userId: string;
	team: string;
	ratingBefore: number;
	ratingAfter: number;
	ratingChange: number;
};

type CreateData = {
	mode: string;
	teamAScore: number;
	teamBScore: number;
	participants: { create: Participant[] };
};

function getCreateData(): CreateData {
	return (mockCreate.mock.calls[0][0] as { data: CreateData }).data;
}

function getParticipants(): Participant[] {
	return getCreateData().participants.create;
}

// ---------- Tests ----------

describe('recordGame', () => {
	it('A wins, equal ratings', async () => {
		const result = await recordGame({
			playerAId: 'player-a',
			playerBId: 'player-b',
			result: 'A',
		});

		expect(mockTransaction).toHaveBeenCalledOnce();

		const data = getCreateData();
		expect(data.mode).toBe('ONE_VS_ONE');
		expect(data.teamAScore).toBe(1);
		expect(data.teamBScore).toBe(0);

		expect(result.ratingChangeA).toBeGreaterThan(0);
		expect(result.ratingChangeB).toBeLessThan(0);

		expect(mockUpdate.mock.calls.length).toBe(2);

		const ratings = mockUpdate.mock.calls.map(
			(call) =>
				(call[0] as { data: { currentRating: number } }).data.currentRating,
		);
		expect(ratings.some((r) => r > 1000)).toBe(true);
		expect(ratings.some((r) => r < 1000)).toBe(true);
	});

	it('B wins, equal ratings', async () => {
		const result = await recordGame({
			playerAId: 'player-a',
			playerBId: 'player-b',
			result: 'B',
		});

		const data = getCreateData();
		expect(data.teamAScore).toBe(0);
		expect(data.teamBScore).toBe(1);

		expect(result.ratingChangeA).toBeLessThan(0);
		expect(result.ratingChangeB).toBeGreaterThan(0);
	});

	it('Draw, equal ratings', async () => {
		const result = await recordGame({
			playerAId: 'player-a',
			playerBId: 'player-b',
			result: 'draw',
		});

		const data = getCreateData();
		expect(data.teamAScore).toBe(0);
		expect(data.teamBScore).toBe(0);

		expect(result.ratingChangeA).toBe(0);
		expect(result.ratingChangeB).toBe(0);
	});

	it('Same player ID throws before DB call', async () => {
		await expect(
			recordGame({ playerAId: 'player-a', playerBId: 'player-a', result: 'A' }),
		).rejects.toThrow('playerAId and playerBId must be different');

		expect(mockFindMany).not.toHaveBeenCalled();
	});

	it('Player A not found', async () => {
		mockFindMany.mockResolvedValue([
			{ id: 'player-b', username: 'bob', currentRating: 1000 } as never,
		]);

		await expect(
			recordGame({ playerAId: 'player-a', playerBId: 'player-b', result: 'A' }),
		).rejects.toThrow('One or both players not found');
	});

	it('Player B not found', async () => {
		mockFindMany.mockResolvedValue([
			{ id: 'player-a', username: 'alice', currentRating: 1000 } as never,
		]);

		await expect(
			recordGame({ playerAId: 'player-a', playerBId: 'player-b', result: 'A' }),
		).rejects.toThrow('One or both players not found');
	});

	it('Neither player found', async () => {
		mockFindMany.mockResolvedValue([]);

		await expect(
			recordGame({ playerAId: 'player-a', playerBId: 'player-b', result: 'A' }),
		).rejects.toThrow('One or both players not found');
	});

	it('Transaction failure propagates', async () => {
		mockTransaction.mockRejectedValue(new Error('DB error'));

		await expect(
			recordGame({ playerAId: 'player-a', playerBId: 'player-b', result: 'A' }),
		).rejects.toThrow('DB error');
	});

	it('ratingBefore snapshot uses current rating at call time', async () => {
		mockFindMany.mockResolvedValue([
			{ id: 'player-a', username: 'alice', currentRating: 1200 } as never,
			{ id: 'player-b', username: 'bob', currentRating: 800 } as never,
		]);

		await recordGame({
			playerAId: 'player-a',
			playerBId: 'player-b',
			result: 'A',
		});

		const participants = getParticipants();
		expect(
			participants.find((p) => p.userId === 'player-a')?.ratingBefore,
		).toBe(1200);
		expect(
			participants.find((p) => p.userId === 'player-b')?.ratingBefore,
		).toBe(800);
	});

	it('ratingAfter consistency (ratingAfter = ratingBefore + ratingChange)', async () => {
		await recordGame({
			playerAId: 'player-a',
			playerBId: 'player-b',
			result: 'A',
		});

		for (const p of getParticipants()) {
			expect(p.ratingAfter).toBe(p.ratingBefore + p.ratingChange);
		}
	});

	it('user.update currentRating matches participant ratingAfter', async () => {
		await recordGame({
			playerAId: 'player-a',
			playerBId: 'player-b',
			result: 'A',
		});

		const participants = getParticipants();
		const updates = mockUpdate.mock.calls.map((call) => {
			const arg = call[0] as {
				where: { id: string };
				data: { currentRating: number };
			};
			return { id: arg.where.id, currentRating: arg.data.currentRating };
		});

		for (const participant of participants) {
			const update = updates.find((u) => u.id === participant.userId);
			expect(update?.currentRating).toBe(participant.ratingAfter);
		}
	});

	it('Team assignment', async () => {
		await recordGame({
			playerAId: 'player-a',
			playerBId: 'player-b',
			result: 'A',
		});

		const participants = getParticipants();
		expect(participants.find((p) => p.userId === 'player-a')?.team).toBe('A');
		expect(participants.find((p) => p.userId === 'player-b')?.team).toBe('B');
	});
});
