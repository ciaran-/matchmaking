// Server-only module — do not import from client-side code.

import type { DerivedSearchState } from './state';
import { getActiveSearches } from './state';
import { ratingBand } from './tolerance';

/**
 * Returns a candidate opponent for `search`, or `null` if no eligible
 * counterpart is currently waiting.
 *
 * Read-only — does not write any events. Lifecycle transitions
 * (MATCHED / PROPOSED) are the caller's responsibility (see
 * `pending-game.ts:proposePendingGame`).
 *
 * The match must be symmetric: both `search` and the candidate must
 * accept each other under their *own* current rating band, where the
 * band widens with elapsed wait time (see `tolerance.ts`). This stops
 * a long-waiting wide-tolerance search from snatching a freshly
 * arrived narrow-tolerance search that would prefer a closer pair.
 *
 * Among the eligible candidates, the closest rating wins; ties break
 * by longest-waiting first (oldest `startedAt`).
 */
export async function findMatchFor(
	search: DerivedSearchState,
	now: Date = new Date(),
): Promise<DerivedSearchState | null> {
	const candidates = await getActiveSearches();

	const searcherElapsed = (now.getTime() - search.startedAt.getTime()) / 1000;
	const searcherBand = ratingBand(search.rating, searcherElapsed);

	const eligible = candidates
		.filter((c) => c.attemptId !== search.attemptId)
		.filter((c) => c.userId !== search.userId)
		.filter((c) => c.rating >= searcherBand.min && c.rating <= searcherBand.max)
		.filter((c) => {
			const candidateElapsed = (now.getTime() - c.startedAt.getTime()) / 1000;
			const candidateBand = ratingBand(c.rating, candidateElapsed);
			return (
				search.rating >= candidateBand.min && search.rating <= candidateBand.max
			);
		})
		.sort((a, b) => {
			const aDelta = Math.abs(a.rating - search.rating);
			const bDelta = Math.abs(b.rating - search.rating);
			if (aDelta !== bDelta) return aDelta - bDelta;
			return a.startedAt.getTime() - b.startedAt.getTime();
		});

	return eligible[0] ?? null;
}
