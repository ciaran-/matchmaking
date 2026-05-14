import * as Sentry from '@sentry/tanstackstart-react';
import { createFileRoute } from '@tanstack/react-router';
import { createServerFn } from '@tanstack/react-start';
import type { EloResult } from '@/lib/elo';

// Server-only modules (`@/db`, `@/lib/matchmaking/*`, `@clerk/backend`,
// `@tanstack/react-start/server`) are deliberately NOT imported at the top
// of this file. They are dynamically imported inside each `createServerFn`
// handler so Vite does not pull them into the client bundle. See
// CLAUDE.md §"createServerFn Pattern".

/**
 * Resolve the authenticated user for the current request. Performs the
 * full Clerk auth dance (mirroring `recordGameFn` in `league.tsx`) and
 * loads the corresponding `User` row from the database.
 *
 * Throws on missing env, missing/invalid Clerk credentials, or if the
 * Clerk user has no matching `User` row.
 *
 * Defined as a local helper rather than a separate module to keep the
 * Clerk integration colocated with its only callers (the six server
 * functions below). All callers run inside `Sentry.startSpan`, so this
 * helper itself does not need its own span wrapper.
 */
async function authenticatedUser() {
	const secretKey = process.env.CLERK_SECRET_KEY;
	const publishableKey = process.env.VITE_CLERK_PUBLISHABLE_KEY;
	if (!secretKey || !publishableKey) {
		throw new Error('Missing Clerk env vars');
	}

	const { createClerkClient } = await import('@clerk/backend');
	const { getRequest } = await import('@tanstack/react-start/server');
	const clerk = createClerkClient({ secretKey, publishableKey });
	// Headers-only clone — TanStack Start has already consumed the original
	// request body to deserialize the server function arguments. See
	// `recordGameFn` in `src/routes/league.tsx`.
	const req = getRequest();
	const auth = await clerk.authenticateRequest(
		new Request(req.url, { headers: req.headers }),
	);
	if (!auth.isSignedIn) throw new Error('Unauthorized');

	const clerkId = auth.toAuth().userId;
	const { prisma } = await import('@/db');
	const dbUser = await prisma.user.findUnique({ where: { clerkId } });
	if (!dbUser) throw new Error('User not found');
	return dbUser;
}

/**
 * Enter the matchmaking queue. Idempotent for the same user — see
 * `createSearch` in `@/lib/matchmaking/search` for the underlying
 * application-layer uniqueness contract (SELECT FOR UPDATE on the
 * user row).
 *
 * After writing the STARTED event, runs the hot-path matcher so a
 * candidate already in the queue gets paired in one round trip; then
 * re-reads the user's current state so the caller sees the post-match
 * status (which may be STARTED or MATCHED).
 */
export const startSearchFn = createServerFn({ method: 'POST' }).handler(
	async () => {
		return Sentry.startSpan(
			{ name: 'Matchmaking: start search server fn' },
			async () => {
				const dbUser = await authenticatedUser();
				const { createSearch } = await import('@/lib/matchmaking/search');
				const { runMatcherForSearch } = await import(
					'@/lib/matchmaking/run-matcher'
				);
				const { getActiveSearchForUser } = await import(
					'@/lib/matchmaking/state'
				);

				const search = await createSearch(dbUser.id);
				await runMatcherForSearch(search.attemptId);
				// Re-read so the caller sees the post-matcher state (STARTED or MATCHED).
				return { search: await getActiveSearchForUser(dbUser.id) };
			},
		);
	},
);

/**
 * Cancel the authenticated user's active search. Throws if the user
 * has no active attempt (their latest event is terminal or no events
 * exist).
 */
export const cancelSearchFn = createServerFn({ method: 'POST' }).handler(
	async () => {
		return Sentry.startSpan(
			{ name: 'Matchmaking: cancel search server fn' },
			async () => {
				const dbUser = await authenticatedUser();
				const { cancelSearch } = await import('@/lib/matchmaking/search');
				const search = await cancelSearch(dbUser.id);
				return { search };
			},
		);
	},
);

/**
 * Polling endpoint for the matchmaking UI. POST (not GET) so router
 * preloading can't accidentally trigger inline expiry, and so this
 * function has a clean place to run `expireIfStale` as a side effect
 * (per plan decision #12).
 *
 * Returns the authenticated user's current `DerivedSearchState` and,
 * if the search is MATCHED, the associated `DerivedMatchState`. If the
 * match is found to be stale on read (PROPOSED/CONFIRMED_BY older than
 * the confirm window), inline-expires it and re-reads both pieces.
 */
export const pollSearchStatusFn = createServerFn({ method: 'POST' }).handler(
	async () => {
		return Sentry.startSpan(
			{ name: 'Matchmaking: poll search status server fn' },
			async () => {
				const dbUser = await authenticatedUser();
				const { getActiveSearchForUser, getMatchState } = await import(
					'@/lib/matchmaking/state'
				);
				const { expireIfStale } = await import(
					'@/lib/matchmaking/pending-game'
				);

				let search = await getActiveSearchForUser(dbUser.id);
				let match: Awaited<ReturnType<typeof getMatchState>> = null;

				if (search?.status === 'MATCHED' && search.matchId) {
					// Inline expiry: if the match has been sitting unconfirmed past
					// the window, this writes EXPIRED events for the match and both
					// searches. `expireIfStale` returns null when the match is not
					// stale; either way we re-read state below.
					const originalMatchId = search.matchId;
					await expireIfStale(originalMatchId);
					// Re-read the search — its status may now be EXPIRED. Read the
					// match by its original id so the UI still sees the (now-EXPIRED)
					// match state even though the user's active search has cleared.
					search = await getActiveSearchForUser(dbUser.id);
					match = await getMatchState(originalMatchId);
				}

				return { search, match };
			},
		);
	},
);

/**
 * Confirm a proposed match on behalf of the authenticated user. The
 * underlying `confirmPendingGame` validates participation, idempotently
 * handles double-clicks, and synthesises a `BOTH_CONFIRMED` event once
 * both players have confirmed.
 */
export const confirmMatchFn = createServerFn({ method: 'POST' })
	.inputValidator((data: { matchId: string }) => data)
	.handler(async ({ data }) => {
		return Sentry.startSpan(
			{ name: 'Matchmaking: confirm match server fn' },
			async () => {
				const dbUser = await authenticatedUser();
				const { confirmPendingGame } = await import(
					'@/lib/matchmaking/pending-game'
				);
				const match = await confirmPendingGame(data.matchId, dbUser.id);
				return { match };
			},
		);
	});

/**
 * Decline a proposed match on behalf of the authenticated user. Per
 * plan decision #7, declining writes DECLINED events for the match and
 * for BOTH source searches — neither player remains queued.
 */
export const declineMatchFn = createServerFn({ method: 'POST' })
	.inputValidator((data: { matchId: string }) => data)
	.handler(async ({ data }) => {
		return Sentry.startSpan(
			{ name: 'Matchmaking: decline match server fn' },
			async () => {
				const dbUser = await authenticatedUser();
				const { declinePendingGame } = await import(
					'@/lib/matchmaking/pending-game'
				);
				const match = await declinePendingGame(data.matchId, dbUser.id);
				return { match };
			},
		);
	});

/**
 * Submit the result of a played match. The wire format expresses the
 * result from the **reporter's** perspective: `'A'` means "I (the
 * reporter) won", `'B'` means "the opponent won".
 *
 * `convertPendingGameToResult` interprets its `result` argument from the
 * match's perspective (`playerAId` vs `playerBId` as recorded in the
 * PROPOSED event) — it does not flip internally. So if the reporter is
 * the match's `playerBId`, this handler swaps `'A' ↔ 'B'` before passing
 * the value through. Draws are unaffected.
 */
export const recordPendingGameResultFn = createServerFn({ method: 'POST' })
	.inputValidator((data: { matchId: string; result: EloResult }) => data)
	.handler(async ({ data }) => {
		return Sentry.startSpan(
			{ name: 'Matchmaking: record pending game result server fn' },
			async () => {
				const dbUser = await authenticatedUser();
				const { getMatchState } = await import('@/lib/matchmaking/state');
				const { convertPendingGameToResult } = await import(
					'@/lib/matchmaking/pending-game'
				);

				const matchState = await getMatchState(data.matchId);
				if (!matchState) {
					throw new Error(`Match ${data.matchId} not found`);
				}
				if (
					dbUser.id !== matchState.playerAId &&
					dbUser.id !== matchState.playerBId
				) {
					throw new Error('Not a participant in this match');
				}

				// Map reporter-perspective ('A' = reporter won) to match-perspective
				// ('A' = playerA won). If the reporter IS playerA, pass through; if
				// the reporter is playerB, flip A/B. Draws pass through unchanged.
				const matchPerspectiveResult: EloResult =
					dbUser.id === matchState.playerAId
						? data.result
						: data.result === 'A'
							? 'B'
							: data.result === 'B'
								? 'A'
								: 'draw';

				const { gameResult, matchState: finalMatch } =
					await convertPendingGameToResult(
						data.matchId,
						dbUser.id,
						matchPerspectiveResult,
					);
				return { gameResult, match: finalMatch };
			},
		);
	});

export const Route = createFileRoute('/match')({
	ssr: 'data-only',
	component: MatchPage,
});

function MatchPage() {
	// UI is implemented in T10. This stub keeps the route renderable so
	// the server functions above can be exercised end-to-end before the
	// state machine lands.
	return <div className="p-4">Matchmaking page — UI coming in T10</div>;
}
