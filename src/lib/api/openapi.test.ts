// @vitest-environment node

import { readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildOpenApiSpec } from './openapi';

const ROUTES_DIR = join(import.meta.dirname, '../../routes/api/v1');

/**
 * Every route file under `src/routes/api/v1`, as the URL path it serves.
 * Walking the filesystem rather than hard-coding a list is the point: a
 * new endpoint shows up here automatically, so an undocumented one fails
 * this suite instead of shipping quietly.
 */
function routePathsOnDisk(dir = ROUTES_DIR): string[] {
	return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
		const full = join(dir, entry.name);
		if (entry.isDirectory()) return routePathsOnDisk(full);
		if (!entry.name.endsWith('.ts')) return [];
		if (entry.name.includes('.test.')) return [];
		// The spec does not document itself.
		if (entry.name.startsWith('openapi')) return [];

		const rel = relative(ROUTES_DIR, full).replace(/\.ts$/, '');
		const path = `/${rel}`
			// `$matchId` in a filename is `{matchId}` in a URL template.
			.replace(/\$(\w+)/g, '{$1}');
		return [path];
	});
}

describe('buildOpenApiSpec', () => {
	const spec = buildOpenApiSpec();

	it('is OpenAPI 3.1 with a server base of /api/v1', () => {
		expect(spec.openapi).toBe('3.1.0');
		expect(spec.servers[0].url).toBe('/api/v1');
	});

	it('documents every route that exists on disk', () => {
		const documented = Object.keys(spec.paths).sort();
		const onDisk = routePathsOnDisk().sort();

		expect(documented).toEqual(onDisk);
	});

	it('describes at least one operation for every path', () => {
		for (const [path, item] of Object.entries(spec.paths)) {
			const methods = Object.keys(item).filter((k) =>
				['get', 'post', 'put', 'patch', 'delete'].includes(k),
			);
			expect(methods.length, `${path} has no operations`).toBeGreaterThan(0);
		}
	});

	it('generates request bodies from the zod schemas the handlers use', () => {
		const games = spec.paths['/games'].post;
		const schema = games.requestBody.content['application/json'].schema as {
			properties: Record<string, unknown>;
			required: string[];
		};

		expect(Object.keys(schema.properties).sort()).toEqual([
			'playerAId',
			'playerBId',
			'result',
		]);
		expect(schema.properties.result).toMatchObject({
			enum: ['A', 'B', 'draw'],
		});
	});

	it('strips the $schema key zod emits, which OpenAPI supplies itself', () => {
		const schema = spec.paths['/games'].post.requestBody.content[
			'application/json'
		].schema as Record<string, unknown>;

		expect(schema.$schema).toBeUndefined();
	});

	it('documents 401 and 429 on every authenticated operation', () => {
		for (const [path, item] of Object.entries(spec.paths)) {
			for (const [method, op] of Object.entries(item)) {
				const responses = (op as { responses: Record<string, unknown> })
					.responses;
				expect(responses['401'], `${method} ${path} lacks 401`).toBeDefined();
				expect(responses['429'], `${method} ${path} lacks 429`).toBeDefined();
			}
		}
	});

	it('serialises to JSON without throwing', () => {
		expect(() => JSON.stringify(spec)).not.toThrow();
	});
});
