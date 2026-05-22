// @vitest-environment jsdom

import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { LeagueActivityBundle } from '@/lib/matchmaking/dashboard';
import { LeagueActivity } from './LeagueActivity';

function bundle(
	overrides: Partial<LeagueActivityBundle> = {},
): LeagueActivityBundle {
	return {
		buckets: [],
		recentResults: { last5Min: 0, lastHour: 0, last24h: 0 },
		generatedAt: new Date().toISOString(),
		...overrides,
	};
}

describe('LeagueActivity', () => {
	it('renders all three counter values', () => {
		render(
			<LeagueActivity
				isLoading={false}
				bundle={bundle({
					recentResults: { last5Min: 3, lastHour: 12, last24h: 47 },
				})}
			/>,
		);

		expect(screen.getByText('Last 5 min')).toBeDefined();
		expect(screen.getByText('Last hour')).toBeDefined();
		expect(screen.getByText('Last 24h')).toBeDefined();
		expect(screen.getByText('3')).toBeDefined();
		expect(screen.getByText('12')).toBeDefined();
		expect(screen.getByText('47')).toBeDefined();
	});

	it('renders one circle per non-zero (bucket, series) pair', () => {
		const { container } = render(
			<LeagueActivity
				isLoading={false}
				bundle={bundle({
					buckets: [
						{
							rating: 1000,
							searching: 2,
							awaitingConfirmation: 1,
							playing: 0,
						},
						{
							rating: 1100,
							searching: 0,
							awaitingConfirmation: 0,
							playing: 3,
						},
					],
				})}
			/>,
		);

		const circles = container.querySelectorAll('circle');
		// 1000: searching + awaitingConfirmation = 2 dots
		// 1100: playing = 1 dot
		expect(circles.length).toBe(3);
	});

	it('renders the empty-state copy when nothing is happening', () => {
		render(<LeagueActivity isLoading={false} bundle={bundle()} />);

		expect(screen.getByText('No activity right now.')).toBeDefined();
	});

	it('does not leak error.message into the DOM', () => {
		const secretMessage = 'connect ECONNREFUSED 127.0.0.1:5432';
		render(
			<LeagueActivity
				isLoading={false}
				bundle={undefined}
				error={{ message: secretMessage }}
			/>,
		);

		expect(screen.getByText("Couldn't load league activity.")).toBeDefined();
		expect(screen.queryByText(secretMessage)).toBeNull();
	});
});
