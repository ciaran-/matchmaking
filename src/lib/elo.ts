/** Standard K-factor. Could later be made dynamic (e.g. higher for new players). */
export const K_FACTOR = 32;

/** Actual result type. */
export type EloResult = 'A' | 'B' | 'draw';

/** Internal only — not exported. Tests cover it indirectly via calculateElo1v1. */
function expectedScore(ratingA: number, ratingB: number): number {
	return 1 / (1 + 10 ** ((ratingB - ratingA) / 400));
}

/**
 * Calculate Elo rating changes for a 1v1 match.
 * Returns { changeA, changeB } as integers (Math.round applied).
 *
 * @param kFactor - Optional override; defaults to K_FACTOR.
 *   Accepts a parameter rather than closing over the constant so future
 *   dynamic K (e.g. provisional ratings) doesn't require a breaking signature change.
 *
 * Note: 'draw' is supported by the formula but callers should verify their
 * win/loss display logic handles draws correctly before using it.
 */
export function calculateElo1v1(
	ratingA: number,
	ratingB: number,
	result: EloResult,
	kFactor: number = K_FACTOR,
): { changeA: number; changeB: number } {
	const expectedA = expectedScore(ratingA, ratingB);
	const expectedB = 1 - expectedA;

	let actualScoreA: number;
	let actualScoreB: number;

	if (result === 'A') {
		actualScoreA = 1;
		actualScoreB = 0;
	} else if (result === 'B') {
		actualScoreA = 0;
		actualScoreB = 1;
	} else {
		actualScoreA = 0.5;
		actualScoreB = 0.5;
	}

	const changeA = Math.round(kFactor * (actualScoreA - expectedA));
	const changeB = Math.round(kFactor * (actualScoreB - expectedB));

	return { changeA, changeB };
}
