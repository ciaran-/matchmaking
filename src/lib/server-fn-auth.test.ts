// @vitest-environment node

import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/auth', () => ({
	authenticatedUser: vi.fn(),
}));

import { authenticatedUser } from '@/lib/auth';
import {
	PUBLIC_SERVER_FNS,
	requireAuthenticatedServerFn,
	serverFnKey,
} from './server-fn-auth';

const mockAuthenticatedUser = vi.mocked(authenticatedUser);

/**
 * Invoke the middleware's server phase directly.
 *
 * Function middleware receives `serverFnMeta` as a required field — that
 * is the whole reason this is function middleware rather than request
 * middleware, where it is undefined.
 */
function run(serverFnMeta: { id: string; name: string; filename: string }) {
	const next = vi.fn().mockResolvedValue({ ok: true });
	const middleware = requireAuthenticatedServerFn.options
		.server as unknown as (opts: {
		serverFnMeta: typeof serverFnMeta;
		next: typeof next;
	}) => Promise<unknown>;

	return { next, result: middleware({ serverFnMeta, next }) };
}

const meta = (filename: string, name: string) => ({
	id: 'deadbeef',
	name,
	filename,
});

beforeEach(() => {
	vi.clearAllMocks();
});

describe('requireAuthenticatedServerFn', () => {
	it('refuses an unauthenticated call and never reaches the handler', async () => {
		mockAuthenticatedUser.mockRejectedValue(new Error('Unauthorized'));

		const { next, result } = run(meta('src/routes/league.tsx', 'anythingFn'));

		// Throwing matches how server functions have always signalled auth
		// failure; the UI maps it via `userFacingError`.
		await expect(result).rejects.toThrow('Unauthorized');
		expect(next).not.toHaveBeenCalled();
	});

	it('allows an authenticated call through', async () => {
		mockAuthenticatedUser.mockResolvedValue({ id: 'u1' } as never);

		const { next, result } = run(meta('src/routes/league.tsx', 'anythingFn'));
		const outcome = await result;

		expect(mockAuthenticatedUser).toHaveBeenCalled();
		expect(next).toHaveBeenCalled();
		// The handler's result passes through untouched.
		expect(outcome).toEqual({ ok: true });
	});

	it('lets an allowlisted function through without authenticating', async () => {
		const { next, result } = run(meta('src/routes/__root.tsx', 'syncUserFn'));
		await result;

		expect(next).toHaveBeenCalled();
		expect(mockAuthenticatedUser).not.toHaveBeenCalled();
	});

	it('does not allowlist a same-named function in another file', async () => {
		mockAuthenticatedUser.mockRejectedValue(new Error('Unauthorized'));

		// The key is filename-scoped, so a `syncUserFn` added elsewhere
		// does not inherit the exemption.
		await expect(
			run(meta('src/routes/elsewhere.tsx', 'syncUserFn')).result,
		).rejects.toThrow('Unauthorized');
	});
});

describe('the allowlist', () => {
	it('is keyed on filename and name, never on the content-hash id', () => {
		// An id-keyed allowlist would silently stop matching after an
		// unrelated edit to the file.
		PUBLIC_SERVER_FNS.forEach((key) => {
			expect(key).toMatch(/^src\/.+\.tsx?:\w+$/);
			expect(key).not.toMatch(/^[a-f0-9]{32,}/);
		});
	});

	it('every entry names a server function that actually exists', () => {
		PUBLIC_SERVER_FNS.forEach((key) => {
			const [filename, name] = key.split(':');
			const source = readFileSync(
				join(import.meta.dirname, '../..', filename),
				'utf8',
			);
			expect(
				source.includes(`${name} = createServerFn`),
				`${key} is allowlisted but not found in ${filename}`,
			).toBe(true);
		});
	});
});

describe('coverage', () => {
	const SRC = join(import.meta.dirname, '..');

	function serverFnsOnDisk(dir: string): string[] {
		return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
			const full = join(dir, entry.name);
			if (entry.isDirectory()) return serverFnsOnDisk(full);
			if (!/\.tsx?$/.test(entry.name) || entry.name.includes('.test.'))
				return [];

			const source = readFileSync(full, 'utf8');
			const filename = `src/${relative(SRC, full)}`;
			return [...source.matchAll(/(\w+) = createServerFn\(/g)].map((match) =>
				serverFnKey({ filename, name: match[1] }),
			);
		});
	}

	// The point of the whole module: this list is the complete set of
	// publicly-callable server functions, and it is short enough to read.
	it('leaves exactly the allowlisted functions public', () => {
		const all = serverFnsOnDisk(join(SRC, 'routes'));

		expect(all.length).toBeGreaterThan(10);
		const publicOnes = all.filter((key) => PUBLIC_SERVER_FNS.has(key));

		expect(publicOnes).toEqual(['src/routes/__root.tsx:syncUserFn']);
	});
});
