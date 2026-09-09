// Server-only module — do not import from client-side code.

import type { z } from 'zod';
import { jsonError } from '@/lib/api/respond';

/**
 * Read and validate a JSON request body at the API edge.
 *
 * Two failure modes need the same answer, and it is easy to get one of
 * them wrong: a body that isn't JSON at all makes `request.json()`
 * *throw*, so a handler that parses inside its main `try` maps a client
 * mistake onto `internal`/500 via `toErrorResponse`. That is wrong twice
 * over — it blames us for their malformed input, and the conventions doc
 * treats every unmapped 500 as a Sentry-worthy bug signal, so ordinary
 * bad requests would bury real defects in noise.
 *
 * Both a malformed body and a schema mismatch return `bad_request`/400
 * with a generic message. Per conventions §5, zod's `issues` array is
 * never serialised into the response — it exposes internal field naming.
 *
 * @example
 * const body = await parseJsonBody(request, schema, 'Body must be …');
 * if (!body.ok) return body.response;
 * // body.data is typed
 */
export async function parseJsonBody<TSchema extends z.ZodType>(
	request: Request,
	schema: TSchema,
	message = 'Invalid request body.',
): Promise<
	{ ok: true; data: z.infer<TSchema> } | { ok: false; response: Response }
> {
	let raw: unknown;
	try {
		raw = await request.json();
	} catch {
		return {
			ok: false,
			response: jsonError('bad_request', message, 400),
		};
	}

	const parsed = schema.safeParse(raw);
	if (!parsed.success) {
		return {
			ok: false,
			response: jsonError('bad_request', message, 400),
		};
	}

	return { ok: true, data: parsed.data };
}
