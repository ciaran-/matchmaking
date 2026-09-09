// @vitest-environment node

import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { parseJsonBody } from './body';
import type { ApiErrorBody } from './respond';

const schema = z.object({
	playerAId: z.string(),
	result: z.enum(['A', 'B', 'draw']),
});

function post(body?: BodyInit): Request {
	return new Request('https://example.test/api/v1/games', {
		method: 'POST',
		body,
	});
}

describe('parseJsonBody', () => {
	it('returns typed data for a valid body', async () => {
		const result = await parseJsonBody(
			post(JSON.stringify({ playerAId: 'a', result: 'A' })),
			schema,
		);

		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.data).toEqual({ playerAId: 'a', result: 'A' });
		}
	});

	it('returns 400, not 500, for a body that is not JSON at all', async () => {
		const result = await parseJsonBody(post('this is not json'), schema);

		expect(result.ok).toBe(false);
		if (!result.ok) {
			const body = (await result.response.json()) as ApiErrorBody;
			expect(result.response.status).toBe(400);
			expect(body.error.code).toBe('bad_request');
		}
	});

	it('returns 400 for an empty body', async () => {
		const result = await parseJsonBody(post(), schema);

		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.response.status).toBe(400);
	});

	it('returns 400 when the body is valid JSON but fails the schema', async () => {
		const result = await parseJsonBody(
			post(JSON.stringify({ playerAId: 'a', result: 'nonsense' })),
			schema,
		);

		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.response.status).toBe(400);
	});

	it('never leaks zod issue detail into the response', async () => {
		const result = await parseJsonBody(
			post(JSON.stringify({ result: 'nope' })),
			schema,
		);

		if (!result.ok) {
			const raw = await result.response.text();
			expect(raw).not.toContain('playerAId');
			expect(raw).not.toContain('invalid_');
			expect(raw).not.toContain('issues');
		}
	});

	it('uses the caller’s message when given one', async () => {
		const result = await parseJsonBody(
			post('{'),
			schema,
			'Body must be a game.',
		);

		if (!result.ok) {
			const body = (await result.response.json()) as ApiErrorBody;
			expect(body.error.message).toBe('Body must be a game.');
		}
	});
});
