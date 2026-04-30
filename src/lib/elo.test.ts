// @vitest-environment node

import { describe, expect, it } from 'vitest';
import { calculateElo1v1 } from './elo';

describe('calculateElo1v1', () => {
	it('equal ratings, A wins: changeA = +16, changeB = -16', () => {
		const { changeA, changeB } = calculateElo1v1(1000, 1000, 'A');
		expect(changeA).toBe(16);
		expect(changeB).toBe(-16);
	});

	it('favourite wins (1500 vs 1000, A wins): changeA = 2, changeB = -2', () => {
		const { changeA, changeB } = calculateElo1v1(1500, 1000, 'A');
		expect(changeA).toBe(2);
		expect(changeB).toBe(-2);
	});

	it('underdog wins (1000 vs 1800, A wins): changeA is large positive', () => {
		const { changeA, changeB } = calculateElo1v1(1000, 1800, 'A');
		expect(changeA).toBe(32);
		expect(changeB).toBe(-32);
	});

	it('B wins equal ratings: changeA = -16, changeB = +16', () => {
		const { changeA, changeB } = calculateElo1v1(1000, 1000, 'B');
		expect(changeA).toBe(-16);
		expect(changeB).toBe(16);
	});

	it('draw between equal players: both changes = 0', () => {
		const { changeA, changeB } = calculateElo1v1(1000, 1000, 'draw');
		expect(changeA).toBe(0);
		expect(changeB).toBe(0);
	});

	it('sum after rounding: Math.abs(changeA + changeB) <= 1 for A wins', () => {
		const { changeA, changeB } = calculateElo1v1(1200, 1000, 'A');
		expect(Math.abs(changeA + changeB)).toBeLessThanOrEqual(1);
	});

	it('sum after rounding: Math.abs(changeA + changeB) <= 1 for B wins', () => {
		const { changeA, changeB } = calculateElo1v1(1200, 1000, 'B');
		expect(Math.abs(changeA + changeB)).toBeLessThanOrEqual(1);
	});

	it('custom K-factor: passing kFactor=16 halves deltas vs default K=32', () => {
		const defaultResult = calculateElo1v1(1000, 1000, 'A');
		const halfKResult = calculateElo1v1(1000, 1000, 'A', 16);
		expect(halfKResult.changeA).toBe(Math.round(defaultResult.changeA / 2));
		expect(halfKResult.changeB).toBe(Math.round(defaultResult.changeB / 2));
	});
});
