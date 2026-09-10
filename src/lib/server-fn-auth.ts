// Server-only module — do not import from client-side code.

import { createMiddleware } from '@tanstack/react-start';
import { authenticatedUser } from '@/lib/auth';

/**
 * Default-deny authentication for every `createServerFn` handler.
 *
 * ## Why this exists
 *
 * Server functions compile to public HTTP endpoints at `/_serverFn/<id>`,
 * and the id ships in the client bundle because the browser needs it to
 * make the call. They are part of the public surface, exactly like the
 * `/api/v1` routes — but authentication was *opt-in*: every handler had
 * to remember to call `authenticatedUser()` itself.
 *
 * Fifteen remembered. Two did not: `getLeaguePlacesFn` returned the whole
 * league table and `listPlayerOptionsFn` returned every player's id and
 * username, to anyone who asked. That was demonstrated rather than
 * theorised — invoking the built server handler with no credentials
 * returned a full page of leaderboard data. Neither was a deliberate
 * decision; they were written without the call, and a missing check is
 * indistinguishable from an intentionally public endpoint when you read
 * the file.
 *
 * So the rule is inverted here. A server function is authenticated unless
 * it appears in `PUBLIC_SERVER_FNS`, which makes "public" a decision
 * someone writes down and defends in review, and makes forgetting produce
 * a refusal instead of a leak.
 *
 * ## Why function middleware rather than request middleware
 *
 * `requestMiddleware` does run for `/_serverFn/*` requests — but
 * `serverFnMeta` is `undefined` there in this version, despite the type
 * documenting it as "only present when the request is handling a server
 * function call". Confirmed by instrumenting it against the built server.
 * Without that metadata there is no way to tell one server function from
 * another, so an allowlist is impossible at that layer.
 *
 * `functionMiddleware` runs per server function and receives
 * `serverFnMeta` as a required field, so it can identify the target.
 */

/**
 * The server functions callable without a credential.
 *
 * Keyed `filename:name`, not by the `id` in `serverFnMeta`. The id is a
 * content hash — it changes whenever the file changes, so an allowlist
 * built on it would silently start denying a function after an unrelated
 * edit, a failure that looks like a bug rather than a security control.
 *
 * **Adding to this list makes an endpoint world-callable.** Anything here
 * needs a reason that survives someone hitting it with curl.
 */
export const PUBLIC_SERVER_FNS: ReadonlySet<string> = new Set([
	// The sign-in path itself. It cannot require an authenticated user
	// because establishing one is its entire job — and it is not
	// unauthenticated in practice: `syncUser` performs its own Clerk
	// verification internally and returns null when there is no session.
	'src/routes/__root.tsx:syncUserFn',
]);

/** The allowlist key for a server function. */
export function serverFnKey(meta: { filename: string; name: string }): string {
	return `${meta.filename}:${meta.name}`;
}

/**
 * Rejects unauthenticated server function calls before the handler runs.
 *
 * Registered globally in `src/start.ts`.
 *
 * Throws rather than returning a 401 response, deliberately: server
 * functions have always signalled auth failure by throwing `Unauthorized`
 * from the handler, and the UI already maps that through
 * `userFacingError` to "Please sign in to continue." Inventing a response
 * shape no caller expects would be the inconsistent choice — unlike the
 * REST API, which has an error envelope and returns a real 401.
 */
export const requireAuthenticatedServerFn = createMiddleware({
	type: 'function',
}).server(async ({ serverFnMeta, next }) => {
	if (PUBLIC_SERVER_FNS.has(serverFnKey(serverFnMeta))) {
		return next();
	}

	// No argument: `authenticatedUser` falls back to a headers-only clone
	// of the ambient request, leaving the body intact for Start to
	// deserialize the function's arguments from. Throws `Unauthorized`.
	await authenticatedUser();

	return next();
});
