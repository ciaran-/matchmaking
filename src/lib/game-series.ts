import { calculateElo1v1, type EloResult, K_FACTOR } from './elo';

export const DEFAULT_RATING = 1000;

export interface GameSeriesInput {
	playerA: string;
	playerB: string;
	result: EloResult;
	kFactor?: number;
}

export interface ProcessSeriesOptions {
	defaultRating?: number;
}

export interface GameAuditEntry {
	index: number;
	playerA: string;
	playerB: string;
	result: EloResult;
	ratingBeforeA: number;
	ratingBeforeB: number;
	changeA: number;
	changeB: number;
	ratingAfterA: number;
	ratingAfterB: number;
}

export interface GameSeriesResult {
	auditTrail: GameAuditEntry[];
	finalRatings: Record<string, number>;
}

export function processGameSeries(
	startingRatings: Record<string, number>,
	games: GameSeriesInput[],
	options?: ProcessSeriesOptions,
): GameSeriesResult {
	const defaultRating = options?.defaultRating ?? DEFAULT_RATING;

	return games.reduce(
		(acc, { playerA, playerB, result, kFactor }, i) => {
			if (playerA === playerB) {
				throw new Error('playerA and playerB must be different');
			}

			const ratingBeforeA = acc.finalRatings[playerA] ?? defaultRating;
			const ratingBeforeB = acc.finalRatings[playerB] ?? defaultRating;

			const { changeA, changeB } = calculateElo1v1(
				ratingBeforeA,
				ratingBeforeB,
				result,
				kFactor ?? K_FACTOR,
			);

			return {
				finalRatings: {
					...acc.finalRatings,
					[playerA]: ratingBeforeA + changeA,
					[playerB]: ratingBeforeB + changeB,
				},
				auditTrail: [
					...acc.auditTrail,
					{
						index: i,
						playerA,
						playerB,
						result,
						ratingBeforeA,
						ratingBeforeB,
						changeA,
						changeB,
						ratingAfterA: ratingBeforeA + changeA,
						ratingAfterB: ratingBeforeB + changeB,
					},
				],
			};
		},
		{
			finalRatings: { ...startingRatings },
			auditTrail: [] as GameAuditEntry[],
		},
	);
}
