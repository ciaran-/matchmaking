import { createFileRoute } from '@tanstack/react-router';
import { apiMiddleware } from '@/lib/api/middleware';
import { buildOpenApiSpec } from '@/lib/api/openapi';
import { jsonOk } from '@/lib/api/respond';

/**
 * `GET /api/v1/openapi.json` — the machine-readable API description.
 *
 * Deliberately unauthenticated: a spec describes the shape of the API,
 * not its data, and requiring a credential to discover how to obtain a
 * credential is a poor first experience. It is still rate limited, like
 * every other route.
 */
export const Route = createFileRoute('/api/v1/openapi.json')({
	server: {
		middleware: [apiMiddleware],
		handlers: {
			GET: () => jsonOk(buildOpenApiSpec()),
		},
	},
});
