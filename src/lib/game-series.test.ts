// @vitest-environment node

import { describe, expect, it } from 'vitest';
import { processGameSeries } from './game-series';

describe('Happy path', () => {
	it('Single game, A wins', () => {
		const result = processGameSeries({ alice: 1000, bob: 1000 }, [
			{ playerA: 'alice', playerB: 'bob', result: 'A' },
		]);

		expect(result.auditTrail).toHaveLength(1);
		const entry = result.auditTrail[0];
		expect(entry.index).toBe(0);
		expect(entry.playerA).toBe('alice');
		expect(entry.playerB).toBe('bob');
		expect(entry.result).toBe('A');
		expect(entry.ratingBeforeA).toBe(1000);
		expect(entry.ratingBeforeB).toBe(1000);
		expect(entry.changeA).toBe(16);
		expect(entry.changeB).toBe(-16);
		expect(entry.ratingAfterA).toBe(1016);
		expect(entry.ratingAfterB).toBe(984);
		expect(result.finalRatings.alice).toBe(1016);
		expect(result.finalRatings.bob).toBe(984);
	});

	it('Single game, B wins', () => {
		const result = processGameSeries({ alice: 1000, bob: 1000 }, [
			{ playerA: 'alice', playerB: 'bob', result: 'B' },
		]);

		const entry = result.auditTrail[0];
		expect(entry.changeA).toBe(-16);
		expect(entry.changeB).toBe(16);
		expect(entry.ratingAfterA).toBe(984);
		expect(entry.ratingAfterB).toBe(1016);
	});

	it('Single game, draw', () => {
		const result = processGameSeries({ alice: 1000, bob: 1000 }, [
			{ playerA: 'alice', playerB: 'bob', result: 'draw' },
		]);

		const entry = result.auditTrail[0];
		expect(entry.changeA).toBe(0);
		expect(entry.changeB).toBe(0);
		expect(entry.ratingAfterA).toBe(1000);
		expect(entry.ratingAfterB).toBe(1000);
	});

	it('Two sequential games, same pair carry ratings forward', () => {
		const result = processGameSeries({ alice: 1000, bob: 1000 }, [
			{ playerA: 'alice', playerB: 'bob', result: 'A' },
			{ playerA: 'alice', playerB: 'bob', result: 'A' },
		]);

		expect(result.auditTrail[1].ratingBeforeA).toBe(
			result.auditTrail[0].ratingAfterA,
		);
		expect(result.auditTrail[1].ratingBeforeB).toBe(
			result.auditTrail[0].ratingAfterB,
		);
	});

	it('Three games, shared player chains correctly', () => {
		const result = processGameSeries({ alice: 1000, bob: 1000, carol: 1000 }, [
			{ playerA: 'alice', playerB: 'bob', result: 'A' },
			{ playerA: 'alice', playerB: 'carol', result: 'B' },
			{ playerA: 'bob', playerB: 'carol', result: 'A' },
		]);

		// alice's rating before game 2 should equal her rating after game 1
		expect(result.auditTrail[1].ratingBeforeA).toBe(
			result.auditTrail[0].ratingAfterA,
		);
		// bob's rating before game 3 should equal his rating after game 1
		expect(result.auditTrail[2].ratingBeforeA).toBe(
			result.auditTrail[0].ratingAfterB,
		);
	});

	it('finalRatings contains all players', () => {
		const result = processGameSeries({ alice: 1000, bob: 1000 }, [
			{ playerA: 'alice', playerB: 'bob', result: 'A' },
		]);

		expect(Object.keys(result.finalRatings)).toContain('alice');
		expect(Object.keys(result.finalRatings)).toContain('bob');
	});
});

describe('Default rating', () => {
	it('Unknown player defaults to 1000', () => {
		const result = processGameSeries({ alice: 1000 }, [
			{ playerA: 'alice', playerB: 'bob', result: 'A' },
		]);

		expect(result.auditTrail[0].ratingBeforeB).toBe(1000);
		expect(result.finalRatings.bob).toBeDefined();
	});

	it('Custom defaultRating', () => {
		const result = processGameSeries(
			{ alice: 1000 },
			[{ playerA: 'alice', playerB: 'bob', result: 'A' }],
			{ defaultRating: 1200 },
		);

		expect(result.auditTrail[0].ratingBeforeB).toBe(1200);
	});

	it('Both players unknown', () => {
		const result = processGameSeries({}, [
			{ playerA: 'alice', playerB: 'bob', result: 'A' },
		]);

		expect(result.auditTrail[0].ratingBeforeA).toBe(1000);
		expect(result.auditTrail[0].ratingBeforeB).toBe(1000);
	});
});

describe('Edge cases', () => {
	it('Empty games array', () => {
		const result = processGameSeries({ alice: 1000 }, []);

		expect(result.auditTrail).toEqual([]);
		expect(result.finalRatings).toEqual({ alice: 1000 });
	});

	it('Players in startingRatings who play no games', () => {
		const result = processGameSeries({ alice: 1000, spectator: 1500 }, [
			{ playerA: 'alice', playerB: 'bob', result: 'A' },
		]);

		expect(result.finalRatings.spectator).toBe(1500);
	});

	it('Per-game kFactor', () => {
		const result = processGameSeries({ alice: 1000, bob: 1000 }, [
			{ playerA: 'alice', playerB: 'bob', result: 'A', kFactor: 16 },
		]);

		const entry = result.auditTrail[0];
		expect(entry.changeA).toBe(8);
		expect(entry.changeB).toBe(-8);
	});

	it('playerA === playerB throws', () => {
		expect(() =>
			processGameSeries({ alice: 1000 }, [
				{ playerA: 'alice', playerB: 'alice', result: 'A' },
			]),
		).toThrow('playerA and playerB must be different');
	});

	it('Input startingRatings not mutated', () => {
		const startingRatings = { alice: 1000, bob: 1000 };
		const original = { ...startingRatings };

		processGameSeries(startingRatings, [
			{ playerA: 'alice', playerB: 'bob', result: 'A' },
		]);

		expect(startingRatings).toEqual(original);
	});
});

describe('Invariants', () => {
	it('index matches position', () => {
		const result = processGameSeries({ alice: 1000, bob: 1000 }, [
			{ playerA: 'alice', playerB: 'bob', result: 'A' },
			{ playerA: 'alice', playerB: 'bob', result: 'B' },
			{ playerA: 'alice', playerB: 'bob', result: 'draw' },
		]);

		expect(result.auditTrail[0].index).toBe(0);
		expect(result.auditTrail[1].index).toBe(1);
		expect(result.auditTrail[2].index).toBe(2);
	});

	it('ratingAfter = ratingBefore + change for all entries', () => {
		const result = processGameSeries({ alice: 1000, bob: 1000 }, [
			{ playerA: 'alice', playerB: 'bob', result: 'A' },
			{ playerA: 'alice', playerB: 'bob', result: 'B' },
			{ playerA: 'alice', playerB: 'bob', result: 'draw' },
		]);

		for (const entry of result.auditTrail) {
			expect(entry.ratingAfterA).toBe(entry.ratingBeforeA + entry.changeA);
			expect(entry.ratingAfterB).toBe(entry.ratingBeforeB + entry.changeB);
		}
	});
});
