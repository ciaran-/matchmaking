// @vitest-environment node

import { describe, expect, it } from 'vitest';
import { toErrorResponse } from './errors';
import type { ApiErrorBody } from './respond';

const FALLBACK = "Couldn't load the leaderboard.";

async function map(e: unknown) {
	const res = toErrorResponse(e, FALLBACK);
	const body = (await res.json()) as ApiErrorBody;
	return { status: res.status, ...body.error };
}

describe('toErrorResponse', () => {
	it('maps Unauthorized to 401 with copy that suits a script, not a browser', async () => {
		const mapped = await map(new Error('Unauthorized'));

		expect(mapped).toEqual({
			status: 401,
			code: 'unauthorized',
			message: 'Missing or invalid credentials.',
		});
		// Not userFacingError's "Please sign in to continue." — an API
		// client holding a key cannot act on that.
		expect(mapped.message).not.toContain('sign in');
	});

	it('maps an unknown credential to 401, not 404', async () => {
		const mapped = await map(new Error('User not found'));

		expect(mapped.status).toBe(401);
		expect(mapped.code).toBe('unauthorized');
	});

	it('maps a non-participant to 403', async () => {
		const mapped = await map(
			new Error('confirmPendingGame: user is not a participant in match m1'),
		);

		expect(mapped.status).toBe(403);
		expect(mapped.code).toBe('forbidden');
	});

	it('maps cancelSearch with nothing active to 409, not 500 (T9)', async () => {
		const mapped = await map(
			new Error(
				'No active search to cancel for user u1 (latest event is terminal or no events exist)',
			),
		);

		expect(mapped.status).toBe(409);
		expect(mapped.code).toBe('conflict');
	});

	it('maps a genuine missing resource to 404', async () => {
		const mapped = await map(
			new Error('confirmPendingGame: match m1 not found'),
		);

		expect(mapped.status).toBe(404);
		expect(mapped.code).toBe('not_found');
	});

	it('maps invalid input to 400', async () => {
		const mapped = await map(
			new Error('playerAId and playerBId must be different'),
		);

		expect(mapped.status).toBe(400);
		expect(mapped.code).toBe('bad_request');
	});

	it.each([
		'declinePendingGame: match m1 is already terminal',
		'convertPendingGameToResult: match m1 is not BOTH_CONFIRMED',
		'convertPendingGameToResult: lost the first-wins race',
	])('maps state conflicts to 409: %s', async (message) => {
		const mapped = await map(new Error(message));

		expect(mapped.status).toBe(409);
		expect(mapped.code).toBe('conflict');
	});

	it('maps anything unrecognised to 500 with the endpoint fallback', async () => {
		const mapped = await map(
			new Error('Invalid `prisma.user.findMany()` invocation'),
		);

		expect(mapped).toEqual({
			status: 500,
			code: 'internal',
			message: FALLBACK,
		});
	});

	it('never leaks the raw thrown message', async () => {
		const mapped = await map(
			new Error('connect ECONNREFUSED 127.0.0.1:5432 for db "matchmaking"'),
		);

		expect(mapped.message).toBe(FALLBACK);
		expect(mapped.message).not.toContain('ECONNREFUSED');
	});

	it('handles a thrown non-Error without crashing', async () => {
		const mapped = await map('just a string');

		expect(mapped.status).toBe(500);
		expect(mapped.code).toBe('internal');
	});
});
