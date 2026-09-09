// Server-only module — do not import from client-side code.

import * as Sentry from '@sentry/tanstackstart-react';
import { type ApiErrorCode, jsonError } from '@/lib/api/respond';
import { userFacingError } from '@/lib/user-facing-errors';

/**
 * Map a thrown `src/lib/` error onto the standard HTTP error envelope.
 *
 * `src/lib/` throws plain `Error`s with descriptive messages and no type
 * taxonomy, so the mapping matches on message content — the same approach
 * `userFacingError` already takes. See
 * `.claude/plans/feature-6-api-conventions.md` §4, which this table is the
 * implementation of; keep the two in step.
 *
 * Anything unrecognised is a 500 on purpose. An unmapped throw is a gap in
 * this table, and a loud 500 in Sentry surfaces it — a catch-all 400 would
 * quietly blame the caller for our bug.
 */

type Rule = {
	matches: (message: string) => boolean;
	code: ApiErrorCode;
	status: number;
	/**
	 * Copy for this case. Auth failures override `userFacingError`, whose
	 * "Please sign in to continue." is written for a browser and means
	 * nothing to a script holding an API key.
	 */
	message?: string;
};

const RULES: Rule[] = [
	{
		matches: (m) => m === 'Unauthorized',
		code: 'unauthorized',
		status: 401,
		message: 'Missing or invalid credentials.',
	},
	{
		// The credential is valid to Clerk but resolves to no local account.
		// That is a problem with the credential, not a missing resource.
		matches: (m) => m === 'User not found',
		code: 'unauthorized',
		status: 401,
		message: 'That credential does not belong to a known user.',
	},
	{
		matches: (m) => m.includes('not a participant'),
		code: 'forbidden',
		status: 403,
	},
	{
		// `cancelSearch` (T9): "No active search to cancel for user X
		// (latest event is terminal or no events exist)". Doesn't say
		// "already terminal" like the pending-game throws, so it needs its
		// own rule — without it this fell through to 500. Either half of
		// the message (no search ever started, or it already ended) is a
		// state conflict from the caller's point of view: there's nothing
		// active to cancel.
		matches: (m) => m.includes('No active search to cancel'),
		code: 'conflict',
		status: 409,
		message: 'You have no active search to cancel.',
	},
	{
		matches: (m) => m.includes('must be different'),
		code: 'bad_request',
		status: 400,
	},
	{
		matches: (m) =>
			m.includes('already terminal') ||
			m.includes('not BOTH_CONFIRMED') ||
			m.includes('first-wins'),
		code: 'conflict',
		status: 409,
	},
	{
		// Checked after the auth rules above, so "User not found" never
		// reaches it.
		matches: (m) => m.includes('not found'),
		code: 'not_found',
		status: 404,
	},
];

/**
 * Turn a caught error into a `Response`.
 *
 * @param fallback - Endpoint-specific copy used when the error is not one
 * of the recognised cases, e.g. "Couldn't load the leaderboard."
 */
export function toErrorResponse(e: unknown, fallback: string): Response {
	const raw = (e as { message?: string }).message ?? '';
	const rule = RULES.find((r) => r.matches(raw));

	if (!rule) {
		// Report explicitly. Sentry's automatic collection only sees
		// *thrown* errors, and this function's whole job is to catch —
		// so without this, every unmapped 500 would be invisible, and
		// the "a loud 500 surfaces it" contract above would be a lie.
		Sentry.captureException(e);
		return jsonError('internal', userFacingError(e, fallback), 500);
	}

	return jsonError(
		rule.code,
		rule.message ?? userFacingError(e, fallback),
		rule.status,
	);
}
