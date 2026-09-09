import { describe, expect, it } from 'vitest';
import { type ApiErrorBody, jsonError, jsonOk } from './respond';

describe('jsonOk', () => {
	it('defaults to 200 with a JSON content type', async () => {
		const res = jsonOk({ hello: 'world' });

		expect(res.status).toBe(200);
		expect(res.headers.get('content-type')).toContain('application/json');
		await expect(res.json()).resolves.toEqual({ hello: 'world' });
	});

	it('serialises the value bare, without a data wrapper', async () => {
		const res = jsonOk([{ id: 'a' }, { id: 'b' }]);

		await expect(res.json()).resolves.toEqual([{ id: 'a' }, { id: 'b' }]);
	});

	it('honours an explicit status', () => {
		expect(jsonOk({ id: 'a' }, 201).status).toBe(201);
	});
});

describe('jsonError', () => {
	it('wraps the code and message in the standard envelope', async () => {
		const res = jsonError('not_found', 'That player does not exist.', 404);

		expect(res.status).toBe(404);
		expect(res.headers.get('content-type')).toContain('application/json');
		await expect(res.json()).resolves.toEqual({
			error: { code: 'not_found', message: 'That player does not exist.' },
		} satisfies ApiErrorBody);
	});

	it('never adds fields beyond error.code and error.message', async () => {
		const body = (await jsonError(
			'internal',
			'Something went wrong.',
			500,
		).json()) as ApiErrorBody;

		expect(Object.keys(body)).toEqual(['error']);
		expect(Object.keys(body.error).sort()).toEqual(['code', 'message']);
	});
});
