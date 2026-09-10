// @vitest-environment node

import { describe, expect, it } from 'vitest';
import { outcomeFor } from './game-outcome';

describe('outcomeFor', () => {
	it('reads a win from the score, for either team', () => {
		expect(outcomeFor('A', 1, 0)).toBe('win');
		expect(outcomeFor('B', 0, 1)).toBe('win');
	});

	it('reads a loss from the score, for either team', () => {
		expect(outcomeFor('A', 0, 1)).toBe('loss');
		expect(outcomeFor('B', 1, 0)).toBe('loss');
	});

	it('reads equal scores as a draw for both teams', () => {
		expect(outcomeFor('A', 0, 0)).toBe('draw');
		expect(outcomeFor('B', 0, 0)).toBe('draw');
		// Not just 0-0: any level score is a draw.
		expect(outcomeFor('A', 3, 3)).toBe('draw');
	});

	it('does not depend on rating change, which is why it is correct', () => {
		// The regression this module exists to prevent. A draw between
		// unequally-rated players moves both ratings — the favourite down,
		// the underdog up — so the old `ratingChange > 0 ? win : loss` rule
		// scored this drawn game as a win for one player and a loss for the
		// other. Only the scores are consulted here, so both read `draw`.
		expect(outcomeFor('A', 0, 0)).toBe('draw');
		expect(outcomeFor('B', 0, 0)).toBe('draw');
	});

	it('is symmetric: the two participants never both win', () => {
		const scores: Array<[number, number]> = [
			[1, 0],
			[0, 1],
			[0, 0],
		];

		scores.forEach(([a, b]) => {
			const forA = outcomeFor('A', a, b);
			const forB = outcomeFor('B', a, b);

			if (forA === 'draw') {
				expect(forB).toBe('draw');
			} else {
				expect(forB).toBe(forA === 'win' ? 'loss' : 'win');
			}
		});
	});
});
