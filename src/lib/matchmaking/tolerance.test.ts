import { describe, expect, it } from 'vitest';
import {
	TOLERANCE_BASE,
	TOLERANCE_CAP,
	TOLERANCE_GROWTH_PER_SEC,
	ratingBand,
	toleranceForElapsed,
} from './tolerance';

describe('toleranceForElapsed', () => {
	it('starts at TOLERANCE_BASE at t=0', () => {
		expect(toleranceForElapsed(0)).toBe(TOLERANCE_BASE);
	});

	it('grows linearly: at t=10s returns TOLERANCE_BASE + 10 * TOLERANCE_GROWTH_PER_SEC', () => {
		expect(toleranceForElapsed(10)).toBe(
			TOLERANCE_BASE + 10 * TOLERANCE_GROWTH_PER_SEC,
		);
	});

	it('grows linearly: at t=5s returns TOLERANCE_BASE + 5 * TOLERANCE_GROWTH_PER_SEC', () => {
		expect(toleranceForElapsed(5)).toBe(
			TOLERANCE_BASE + 5 * TOLERANCE_GROWTH_PER_SEC,
		);
	});

	it('caps at TOLERANCE_CAP for very large elapsed values', () => {
		expect(toleranceForElapsed(1000)).toBe(TOLERANCE_CAP);
	});

	it('reaches the cap exactly at the boundary', () => {
		const secondsToCap =
			(TOLERANCE_CAP - TOLERANCE_BASE) / TOLERANCE_GROWTH_PER_SEC;
		expect(toleranceForElapsed(secondsToCap)).toBe(TOLERANCE_CAP);
		expect(toleranceForElapsed(secondsToCap + 1)).toBe(TOLERANCE_CAP);
	});

	it('clamps negative elapsedSeconds to base tolerance', () => {
		expect(toleranceForElapsed(-5)).toBe(TOLERANCE_BASE);
		expect(toleranceForElapsed(-1000)).toBe(TOLERANCE_BASE);
	});
});

describe('ratingBand', () => {
	it('returns symmetric band around rating at t=0', () => {
		expect(ratingBand(1000, 0)).toEqual({ min: 950, max: 1050 });
	});

	it('widens the band as elapsed grows', () => {
		expect(ratingBand(1000, 10)).toEqual({
			min: 1000 - (TOLERANCE_BASE + 10 * TOLERANCE_GROWTH_PER_SEC),
			max: 1000 + (TOLERANCE_BASE + 10 * TOLERANCE_GROWTH_PER_SEC),
		});
	});

	it('caps the band width at +/- TOLERANCE_CAP', () => {
		expect(ratingBand(1500, 10_000)).toEqual({
			min: 1500 - TOLERANCE_CAP,
			max: 1500 + TOLERANCE_CAP,
		});
	});

	it('returns the base band for negative elapsed (clamped)', () => {
		expect(ratingBand(1000, -5)).toEqual(ratingBand(1000, 0));
	});
});
