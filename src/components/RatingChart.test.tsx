// @vitest-environment jsdom

import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { RatingHistoryPoint } from '@/lib/player-rating-history';
import { RatingChart } from './RatingChart';

function point(
	overrides: Partial<RatingHistoryPoint> = {},
): RatingHistoryPoint {
	return {
		rating: 1016,
		at: '2026-01-01T00:00:00.000Z',
		gameResultId: 'game_1',
		...overrides,
	};
}

describe('RatingChart', () => {
	it('renders a single point for a player with no games', () => {
		const { container } = render(
			<RatingChart history={[]} isLoading={false} />,
		);

		const circles = container.querySelectorAll('circle');
		expect(circles.length).toBe(1);
		// One point can't form a line.
		expect(container.querySelector('polyline')).toBeNull();
	});

	it('renders two points and a line for a player with one game', () => {
		const { container } = render(
			<RatingChart history={[point()]} isLoading={false} />,
		);

		const circles = container.querySelectorAll('circle');
		expect(circles.length).toBe(2);
		expect(container.querySelector('polyline')).not.toBeNull();
	});

	it('renders one point per game plus the starting point', () => {
		const { container } = render(
			<RatingChart
				history={[
					point({ rating: 1016, gameResultId: 'g1' }),
					point({ rating: 1008, gameResultId: 'g2' }),
					point({ rating: 1024, gameResultId: 'g3' }),
				]}
				isLoading={false}
			/>,
		);

		expect(container.querySelectorAll('circle').length).toBe(4);
	});

	it('gives the chart an accessible name summarising the trend', () => {
		const { container } = render(
			<RatingChart
				history={[point({ rating: 1016, gameResultId: 'g1' })]}
				isLoading={false}
			/>,
		);

		const svg = container.querySelector('svg');
		expect(svg?.getAttribute('role')).toBe('img');
		expect(svg?.getAttribute('aria-label')).toContain('1 game');
		expect(svg?.getAttribute('aria-label')).toContain('1000');
		expect(svg?.getAttribute('aria-label')).toContain('1016');
	});

	it('renders the loading state with no chart', () => {
		const { container } = render(
			<RatingChart history={undefined} isLoading={true} />,
		);

		expect(container.querySelector('svg')).toBeNull();
	});

	it('does not leak error.message into the DOM', () => {
		const secretMessage = 'connect ECONNREFUSED 127.0.0.1:5432';
		const { getByText, queryByText } = render(
			<RatingChart
				history={undefined}
				isLoading={false}
				error={{ message: secretMessage }}
			/>,
		);

		expect(getByText("Couldn't load rating history.")).toBeDefined();
		expect(queryByText(secretMessage)).toBeNull();
	});
});
