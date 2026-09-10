// @vitest-environment node

import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/auth', () => ({ resolveActor: vi.fn() }));

import { resolveActor } from '@/lib/auth';
import { apiMiddleware } from './middleware';
import type { ApiErrorBody } from './respond';

const mockResolveActor = vi.mocked(resolveActor);

const API_ROUTES = join(import.meta.dirname, '../../routes/api/v1');

/** Every route file under `src/routes/api/v1`, as repo-relative paths. */
function routeFiles(dir = API_ROUTES): string[] {
	return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
		const full = join(dir, entry.name);
		if (entry.isDirectory()) return routeFiles(full);
		if (!entry.name.endsWith('.ts') || entry.name.includes('.test.')) return [];
		return [full];
	});
}

/**
 * The guarantee behind default-deny.
 *
 * `apiMiddleware` enforces authentication for the whole `/api/v1` surface,
 * but only for routes that actually attach it. A route that omits it is
 * unauthenticated *and* unrated-limited, and looks entirely normal in
 * review — so this asserts the invariant instead of trusting it.
 */
describe('every API route attaches apiMiddleware', () => {
	const files = routeFiles();

	it('finds the route files at all', () => {
		// Guards against this suite silently passing because the glob broke.
		expect(files.length).toBeGreaterThan(5);
	});

	it.each(files.map((f) => [relative(API_ROUTES, f), f]))(
		'%s',
		(_name, file) => {
			const source = readFileSync(file, 'utf8');

			expect(source).toContain('middleware: [apiMiddleware]');
		},
	);
});

/** Invoke the middleware's server phase directly. */
function run(pathname: string) {
	const next = vi.fn().mockResolvedValue({ ok: true });
	const middleware = apiMiddleware.options.server as unknown as (opts: {
		request: Request;
		pathname: string;
		next: typeof next;
	}) => Promise<unknown>;

	return {
		next,
		result: middleware({
			request: new Request(`https://example.test${pathname}`, {
				headers: { authorization: `Bearer key-${pathname}` },
			}),
			pathname,
			next,
		}),
	};
}

describe('apiMiddleware authentication', () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it('refuses an unauthenticated request before the handler runs', async () => {
		mockResolveActor.mockRejectedValue(new Error('Unauthorized'));

		const { next, result } = run('/api/v1/leaderboard');
		const response = (await result) as Response;
		const body = (await response.json()) as ApiErrorBody;

		expect(response.status).toBe(401);
		expect(body.error.code).toBe('unauthorized');
		// The point of default-deny: the handler is never reached, so a
		// route that forgot its own check is still safe.
		expect(next).not.toHaveBeenCalled();
	});

	it('lets an authenticated request through to the handler', async () => {
		mockResolveActor.mockResolvedValue({
			kind: 'user',
			user: { id: 'u1' },
		} as never);

		const { next, result } = run('/api/v1/leaderboard');
		await result;

		expect(next).toHaveBeenCalled();
	});

	it('lets the spec through without a credential', async () => {
		mockResolveActor.mockRejectedValue(new Error('Unauthorized'));

		const { next, result } = run('/api/v1/openapi.json');
		await result;

		expect(next).toHaveBeenCalled();
		expect(mockResolveActor).not.toHaveBeenCalled();
	});

	it('does not exempt a path that merely contains the public one', async () => {
		mockResolveActor.mockRejectedValue(new Error('Unauthorized'));

		// Exact match, not prefix or substring — otherwise a route like
		// /api/v1/openapi.json/secrets would inherit the exemption.
		const response = (await run('/api/v1/openapi.json/secrets')
			.result) as Response;

		expect(response.status).toBe(401);
	});
});
