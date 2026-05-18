// Server-only module — do not import from client-side code.

import * as Sentry from '@sentry/tanstackstart-react';
import { findMatchFor } from './matcher';
import {
	expireIfStale,
	PENDING_GAME_CONFIRM_WINDOW_SECONDS,
	proposePendingGame,
} from './pending-game';
import { reapAbandonedSearches } from './search';
import { getActiveSearches, getSearchAttempt, getStaleMatchIds } from './state';

/**
 * A search whose latest event is `STARTED` for longer than this is
 * treated as abandoned by the scheduled tick (the player closed their
 * tab without cancelling). Tunable; matches plan decision #15.
 */
export const ABANDONED_AFTER_SECONDS = 60 * 5; // 5 minutes

/**
 * Hot-path entry point. Called from `startSearchFn` immediately after
 * `createSearch` so that two players entering the queue at the same
 * time get paired in one round-trip rather than waiting for the next
 * scheduled tick.
 *
 * Returns `{ matched: true }` when a `PROPOSED` event was successfully
 * written, `{ matched: false }` otherwise. The race path — where a
 * concurrent caller has already paired our candidate (or our search) —
 * is treated as "not matched this pass" rather than an error: the
 * search remains active for the next pass, and the caller doesn't need
 * to distinguish "no candidate available" from "lost the race".
 */
export async function runMatcherForSearch(
	attemptId: string,
): Promise<{ matched: boolean }> {
	return Sentry.startSpan(
		{ name: 'Matchmaking: run matcher for search' },
		async () => {
			const search = await getSearchAttempt(attemptId);
			if (!search || search.status !== 'STARTED') {
				return { matched: false };
			}

			const candidate = await findMatchFor(search);
			if (!candidate) {
				return { matched: false };
			}

			try {
				await proposePendingGame(search.attemptId, candidate.attemptId);
				return { matched: true };
			} catch (_) {
				// Race lost — either our candidate was paired by another caller,
				// or our search has progressed past STARTED in the meantime.
				// Both surface as "not matched this pass"; the next pass will
				// pick the search back up if it's still active.
				return { matched: false };
			}
		},
	);
}

/**
 * Scheduled-tick entry point. Three responsibilities, in order:
 *
 * 1. Reap `STARTED`-as-latest searches older than `ABANDONED_AFTER_SECONDS`
 *    by appending an `ABANDONED` event each.
 * 2. Expire stale `PROPOSED`/`CONFIRMED_BY` matches that no live polling
 *    client has cleared. The hot path expires individually on poll; this
 *    handles the case where both players walked away.
 * 3. Loop over the remaining active searches, attempting to pair them.
 *    A successful pairing changes the active-set, so loop until a full
 *    pass produces no new matches (idempotency).
 */
export async function runMatcherPass(): Promise<{
	matchesCreated: number;
	searchesReaped: number;
	pendingGamesExpired: number;
}> {
	return Sentry.startSpan(
		{ name: 'Matchmaking: run matcher pass' },
		async () => {
			// 1. Reap abandoned searches first — removes them from the
			//    active-search set the matcher will iterate next.
			const searchesReaped = await reapAbandonedSearches(
				ABANDONED_AFTER_SECONDS,
			);

			// 2. Expire stale PROPOSED / CONFIRMED_BY matches. `expireIfStale`
			//    is idempotent under its own re-derivation, and returns null
			//    when the match has progressed (e.g. someone confirmed in the
			//    intervening ms) — count only true expirations.
			const staleMatchIds = await getStaleMatchIds(
				PENDING_GAME_CONFIRM_WINDOW_SECONDS,
			);
			const expirationResults = await Promise.all(
				staleMatchIds.map((id) => expireIfStale(id)),
			);
			const pendingGamesExpired = expirationResults.filter(
				(r) => r !== null,
			).length;

			// 3. Iterate active searches, attempting matches until a pass
			//    produces no new pairs. The inner loop trusts
			//    `runMatcherForSearch` to swallow race-lost cases; we just
			//    count wins and re-loop when any did succeed.
			let matchesCreated = 0;
			let progress = true;
			while (progress) {
				progress = false;
				const actives = await getActiveSearches();
				for (const s of actives) {
					const result = await runMatcherForSearch(s.attemptId);
					if (result.matched) {
						matchesCreated++;
						progress = true;
					}
				}
			}

			return { matchesCreated, searchesReaped, pendingGamesExpired };
		},
	);
}
