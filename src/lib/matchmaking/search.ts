// Server-only module — do not import from client-side code.

import { randomUUID } from 'node:crypto';
import * as Sentry from '@sentry/tanstackstart-react';
import { prisma } from '@/db';
import {
	type DerivedSearchState,
	getActiveSearchForUser,
	getSearchAttempt,
} from './state';

/**
 * Create (or return the existing) STARTED search attempt for a user.
 *
 * Idempotent — if the user already has an active attempt (latest event
 * STARTED or MATCHED), returns that state without writing a new event.
 * This makes the call safe for tab-refresh / multi-tab scenarios.
 *
 * Concurrency: runs inside a `prisma.$transaction` and locks the user
 * row with `SELECT … FOR UPDATE` so two concurrent calls for the same
 * user serialise — one writes the STARTED event, the other reads it
 * back and returns idempotently. This eliminates the race window for
 * a single user (per plan decision #13: application-layer uniqueness).
 */
export async function createSearch(
	userId: string,
): Promise<DerivedSearchState> {
	return Sentry.startSpan({ name: 'Matchmaking: create search' }, async () => {
		return prisma.$transaction(async (tx) => {
			// Lock the user row so concurrent createSearch calls for this
			// user serialise. The lock is released when the transaction
			// commits or rolls back.
			await tx.$queryRaw`SELECT id FROM "User" WHERE id = ${userId} FOR UPDATE`;

			const existing = await getActiveSearchForUser(userId, tx);
			if (existing) return existing;

			const user = await tx.user.findUnique({ where: { id: userId } });
			if (!user) throw new Error(`User not found: ${userId}`);

			const attemptId = randomUUID();
			await tx.matchmakingSearchEvent.create({
				data: {
					attemptId,
					userId,
					type: 'STARTED',
					rating: user.currentRating,
				},
			});

			const created = await getSearchAttempt(attemptId, tx);
			if (!created) {
				throw new Error(
					`Invariant violation: just-inserted attempt ${attemptId} not found`,
				);
			}
			return created;
		});
	});
}

/**
 * Append a CANCELLED event to the user's active search attempt.
 *
 * Throws if the user has no active attempt, or if the latest event is
 * already terminal (the search can only be cancelled while STARTED or
 * MATCHED).
 */
export async function cancelSearch(
	userId: string,
): Promise<DerivedSearchState> {
	return Sentry.startSpan({ name: 'Matchmaking: cancel search' }, async () => {
		const active = await getActiveSearchForUser(userId);
		if (!active) {
			throw new Error(
				`No active search to cancel for user ${userId} (latest event is terminal or no events exist)`,
			);
		}

		await prisma.matchmakingSearchEvent.create({
			data: {
				attemptId: active.attemptId,
				userId: active.userId,
				type: 'CANCELLED',
			},
		});

		const updated = await getSearchAttempt(active.attemptId);
		if (!updated) {
			throw new Error(
				`Invariant violation: attempt ${active.attemptId} disappeared after CANCELLED write`,
			);
		}
		return updated;
	});
}

/**
 * Reaper for abandoned searches. Finds attempts whose latest event is
 * STARTED and whose STARTED event is older than `staleAfterSeconds`,
 * and appends an ABANDONED event for each.
 *
 * Bulk-inserts via `createMany`. A race with a concurrent writer (e.g.
 * a player who just queued and is being reaped at the same instant) is
 * acceptable: the latest-event-wins semantics resolve the order, and
 * the player can simply re-queue if their attempt is closed.
 *
 * Returns the number of attempts reaped.
 */
export async function reapAbandonedSearches(
	staleAfterSeconds: number,
): Promise<number> {
	return Sentry.startSpan(
		{ name: 'Matchmaking: reap abandoned searches' },
		async () => {
			// Find attemptIds whose latest event is STARTED and whose
			// STARTED.createdAt is older than the cutoff. The DISTINCT ON
			// picks the most recent event per attempt; we then filter to
			// the STARTED-as-latest case (i.e. the attempt has not
			// progressed).
			const cutoff = new Date(Date.now() - staleAfterSeconds * 1000);
			const rows = await prisma.$queryRaw<
				{ attemptId: string; userId: string; createdAt: Date; type: string }[]
			>`
				SELECT DISTINCT ON ("attemptId")
					"attemptId", "userId", "createdAt", "type"::text AS "type"
				FROM "MatchmakingSearchEvent"
				ORDER BY "attemptId", "createdAt" DESC
			`;

			const stale = rows.filter(
				(r) => r.type === 'STARTED' && r.createdAt < cutoff,
			);
			if (stale.length === 0) return 0;

			const { count } = await prisma.matchmakingSearchEvent.createMany({
				data: stale.map((r) => ({
					attemptId: r.attemptId,
					userId: r.userId,
					type: 'ABANDONED' as const,
				})),
			});
			return count;
		},
	);
}
