import { describe, expect, it } from 'vitest';
import type { DerivedMatchState } from '@/lib/matchmaking/state';
import { serializeMatchState } from './serialize';

const baseMatch: DerivedMatchState = {
	matchId: 'm1',
	playerAId: 'userA',
	playerBId: 'userB',
	playerARating: 1000,
	playerBRating: 1010,
	searchAAttemptId: 'attemptA',
	searchBAttemptId: 'attemptB',
	proposedAt: new Date('2026-01-01T00:00:00.000Z'),
	status: 'PROPOSED',
	confirmedBy: new Set(),
	gameResultId: null,
	latestEventAt: new Date('2026-01-01T00:00:01.000Z'),
};

describe('serializeMatchState', () => {
	it('turns confirmedBy into an array', () => {
		const match = { ...baseMatch, confirmedBy: new Set(['userA', 'userB']) };

		const serialized = serializeMatchState(match);

		expect(serialized.confirmedBy).toEqual(['userA', 'userB']);
	});

	it('survives round-tripping through JSON.stringify, unlike the raw Set', () => {
		const match = { ...baseMatch, confirmedBy: new Set(['userA']) };

		// The bug this file exists to prevent: JSON.stringify(new Set(...))
		// is "{}" — confirmedBy silently vanishes.
		expect(JSON.parse(JSON.stringify(match)).confirmedBy).toEqual({});

		const roundTripped = JSON.parse(JSON.stringify(serializeMatchState(match)));
		expect(roundTripped.confirmedBy).toEqual(['userA']);
	});

	it('preserves every other field unchanged', () => {
		const match = { ...baseMatch, confirmedBy: new Set(['userA']) };

		const serialized = serializeMatchState(match);

		expect(serialized).toMatchObject({
			matchId: 'm1',
			playerAId: 'userA',
			playerBId: 'userB',
			playerARating: 1000,
			playerBRating: 1010,
			searchAAttemptId: 'attemptA',
			searchBAttemptId: 'attemptB',
			status: 'PROPOSED',
			gameResultId: null,
		});
	});

	it('returns an empty array for an unconfirmed match', () => {
		expect(serializeMatchState(baseMatch).confirmedBy).toEqual([]);
	});
});
