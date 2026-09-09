// Server-only module — do not import from client-side code.

/**
 * Shared response serialisation for the REST API (`/api/v1/...`).
 *
 * Every route serialises through these two helpers so the success and
 * error shapes are identical across the whole surface. See
 * `.claude/plans/feature-6-api-conventions.md` for the envelope contract
 * and the lib-error → HTTP status mapping table.
 */

/** Machine-readable error codes. Clients branch on these, not on `message`. */
export type ApiErrorCode =
	| 'bad_request'
	| 'unauthorized'
	| 'forbidden'
	| 'not_found'
	| 'conflict'
	| 'rate_limited'
	| 'internal';

export type ApiErrorBody = {
	error: {
		code: ApiErrorCode;
		message: string;
	};
};

/**
 * A successful response. Reads return the bare resource; only endpoints
 * that need envelope metadata (pagination) wrap in `{ data }`.
 */
export function jsonOk(value: unknown, status = 200): Response {
	return Response.json(value, { status });
}

/**
 * An error response in the standard envelope. `message` is always
 * user-facing copy (via `userFacingError`), never a raw thrown message —
 * Sentry keeps the original for diagnosis.
 */
export function jsonError(
	code: ApiErrorCode,
	message: string,
	status: number,
): Response {
	const body: ApiErrorBody = { error: { code, message } };
	return Response.json(body, { status });
}
