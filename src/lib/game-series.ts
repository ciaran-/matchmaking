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

	const workingRatings = new Map<string, number>(
		Object.entries(startingRatings),
	);

	function getRating(id: string): number {
		return workingRatings.has(id)
			? (workingRatings.get(id) as number)
			: defaultRating;
	}

	const auditTrail: GameAuditEntry[] = [];

	for (let i = 0; i < games.length; i++) {
		const game = games[i];
		const { playerA, playerB, result } = game;

		if (playerA === playerB) {
			throw new Error('playerA and playerB must be different');
		}

		const ratingBeforeA = getRating(playerA);
		const ratingBeforeB = getRating(playerB);

		const { changeA, changeB } = calculateElo1v1(
			ratingBeforeA,
			ratingBeforeB,
			result,
			game.kFactor ?? K_FACTOR,
		);

		const ratingAfterA = ratingBeforeA + changeA;
		const ratingAfterB = ratingBeforeB + changeB;

		workingRatings.set(playerA, ratingAfterA);
		workingRatings.set(playerB, ratingAfterB);

		auditTrail.push({
			index: i,
			playerA,
			playerB,
			result,
			ratingBeforeA,
			ratingBeforeB,
			changeA,
			changeB,
			ratingAfterA,
			ratingAfterB,
		});
	}

	return {
		auditTrail,
		finalRatings: Object.fromEntries(workingRatings),
	};
}
