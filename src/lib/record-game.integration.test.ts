// @vitest-environment node

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from '@/test/db';
import { twoEqualRatedPlayers, twoUnequalRatedPlayers } from '@/test/scenarios';
import { recordGame } from './record-game';

let db: TestDatabase;

beforeAll(async () => {
	db = await createTestDatabase();
}, 60_000);

beforeEach(async () => {
	await db.reset();
});

afterAll(async () => {
	await db.teardown();
});

describe('recordGame', () => {
	it('increases winner rating and decreases loser rating when A wins', async () => {
		const [playerA, playerB] = await twoEqualRatedPlayers(db.prisma);

		const { ratingChangeA, ratingChangeB } = await recordGame({
			playerAId: playerA.id,
			playerBId: playerB.id,
			result: 'A',
		});

		expect(ratingChangeA).toBeGreaterThan(0);
		expect(ratingChangeB).toBeLessThan(0);

		const updatedA = await db.prisma.user.findUniqueOrThrow({
			where: { id: playerA.id },
		});
		const updatedB = await db.prisma.user.findUniqueOrThrow({
			where: { id: playerB.id },
		});

		expect(updatedA.currentRating).toBe(playerA.currentRating + ratingChangeA);
		expect(updatedB.currentRating).toBe(playerB.currentRating + ratingChangeB);
	});

	it('increases winner rating and decreases loser rating when B wins', async () => {
		const [playerA, playerB] = await twoEqualRatedPlayers(db.prisma);

		const { ratingChangeA, ratingChangeB } = await recordGame({
			playerAId: playerA.id,
			playerBId: playerB.id,
			result: 'B',
		});

		expect(ratingChangeA).toBeLessThan(0);
		expect(ratingChangeB).toBeGreaterThan(0);

		const updatedA = await db.prisma.user.findUniqueOrThrow({
			where: { id: playerA.id },
		});
		const updatedB = await db.prisma.user.findUniqueOrThrow({
			where: { id: playerB.id },
		});

		expect(updatedA.currentRating).toBe(playerA.currentRating + ratingChangeA);
		expect(updatedB.currentRating).toBe(playerB.currentRating + ratingChangeB);
	});

	it('does not change ratings on a draw between equal players', async () => {
		const [playerA, playerB] = await twoEqualRatedPlayers(db.prisma);

		const { ratingChangeA, ratingChangeB } = await recordGame({
			playerAId: playerA.id,
			playerBId: playerB.id,
			result: 'draw',
		});

		expect(ratingChangeA).toBe(0);
		expect(ratingChangeB).toBe(0);

		const updatedA = await db.prisma.user.findUniqueOrThrow({
			where: { id: playerA.id },
		});
		const updatedB = await db.prisma.user.findUniqueOrThrow({
			where: { id: playerB.id },
		});

		expect(updatedA.currentRating).toBe(playerA.currentRating);
		expect(updatedB.currentRating).toBe(playerB.currentRating);
	});

	it('creates a GameResult row with correct mode and scores', async () => {
		const [playerA, playerB] = await twoEqualRatedPlayers(db.prisma);

		const { gameResult } = await recordGame({
			playerAId: playerA.id,
			playerBId: playerB.id,
			result: 'A',
		});

		const row = await db.prisma.gameResult.findUniqueOrThrow({
			where: { id: gameResult.id },
			include: { participants: true },
		});

		expect(row.mode).toBe('ONE_VS_ONE');
		expect(row.teamAScore).toBe(1);
		expect(row.teamBScore).toBe(0);
		expect(row.participants).toHaveLength(2);
	});

	it('assigns correct team to each participant', async () => {
		const [playerA, playerB] = await twoEqualRatedPlayers(db.prisma);

		const { gameResult } = await recordGame({
			playerAId: playerA.id,
			playerBId: playerB.id,
			result: 'A',
		});

		const { participants } = await db.prisma.gameResult.findUniqueOrThrow({
			where: { id: gameResult.id },
			include: { participants: true },
		});

		const pA = participants.find((p) => p.userId === playerA.id);
		const pB = participants.find((p) => p.userId === playerB.id);

		expect(pA?.team).toBe('A');
		expect(pB?.team).toBe('B');
	});

	it('records ratingBefore matching the players currentRating at the time of the call', async () => {
		const [playerA, playerB] = await twoUnequalRatedPlayers(
			db.prisma,
			1200,
			800,
		);

		const { gameResult } = await recordGame({
			playerAId: playerA.id,
			playerBId: playerB.id,
			result: 'A',
		});

		const { participants } = await db.prisma.gameResult.findUniqueOrThrow({
			where: { id: gameResult.id },
			include: { participants: true },
		});

		const pA = participants.find((p) => p.userId === playerA.id);
		const pB = participants.find((p) => p.userId === playerB.id);

		expect(pA?.ratingBefore).toBe(1200);
		expect(pB?.ratingBefore).toBe(800);
	});

	it('records ratingAfter = ratingBefore + ratingChange for both participants', async () => {
		const [playerA, playerB] = await twoUnequalRatedPlayers(
			db.prisma,
			1200,
			800,
		);

		const { gameResult } = await recordGame({
			playerAId: playerA.id,
			playerBId: playerB.id,
			result: 'A',
		});

		const { participants } = await db.prisma.gameResult.findUniqueOrThrow({
			where: { id: gameResult.id },
			include: { participants: true },
		});

		const pA = participants.find((p) => p.userId === playerA.id);
		const pB = participants.find((p) => p.userId === playerB.id);

		expect(pA?.ratingAfter).toBe(
			(pA?.ratingBefore ?? 0) + (pA?.ratingChange ?? 0),
		);
		expect(pB?.ratingAfter).toBe(
			(pB?.ratingBefore ?? 0) + (pB?.ratingChange ?? 0),
		);
	});

	it('produces a larger rating swing when the lower-rated player wins (upset)', async () => {
		const [playerA, playerB] = await twoUnequalRatedPlayers(
			db.prisma,
			1200,
			800,
		);

		const { ratingChangeA, ratingChangeB } = await recordGame({
			playerAId: playerA.id,
			playerBId: playerB.id,
			result: 'B', // underdog wins
		});

		expect(ratingChangeB).toBeGreaterThan(16);
		expect(ratingChangeA).toBeLessThan(-16);
	});

	it('uses updated ratings as ratingBefore for a subsequent game', async () => {
		const [playerA, playerB] = await twoEqualRatedPlayers(db.prisma);

		await recordGame({
			playerAId: playerA.id,
			playerBId: playerB.id,
			result: 'A',
		});

		const updatedA = await db.prisma.user.findUniqueOrThrow({
			where: { id: playerA.id },
		});
		const updatedB = await db.prisma.user.findUniqueOrThrow({
			where: { id: playerB.id },
		});

		const { gameResult } = await recordGame({
			playerAId: playerA.id,
			playerBId: playerB.id,
			result: 'B',
		});

		const { participants } = await db.prisma.gameResult.findUniqueOrThrow({
			where: { id: gameResult.id },
			include: { participants: true },
		});
		const pA = participants.find((p) => p.userId === playerA.id);
		const pB = participants.find((p) => p.userId === playerB.id);

		expect(pA?.ratingBefore).toBe(updatedA.currentRating);
		expect(pB?.ratingBefore).toBe(updatedB.currentRating);
	});
});
