// Server-only module — do not import from client-side code.

import { randomUUID } from 'node:crypto';
import type { GameResult } from '@prisma/client';
import * as Sentry from '@sentry/tanstackstart-react';
import { prisma } from '@/db';
import type { EloResult } from '../elo';
import { recordGame } from '../record-game';
import {
	type DerivedMatchState,
	type DerivedSearchState,
	getMatchState,
	getSearchAttempt,
} from './state';

/**
 * Default confirm window for a proposed match. Once a match has been
 * proposed for more than this many seconds without both players
 * confirming, `expireIfStale` will append `EXPIRED` events for the
 * match and both searches.
 */
export const PENDING_GAME_CONFIRM_WINDOW_SECONDS = 10;

const TERMINAL_MATCH_STATUSES = new Set(['DECLINED', 'EXPIRED', 'PLAYED']);

/**
 * Propose a pending match for the two given search attempts.
 *
 * Concurrency contract (the entire flow runs inside a single
 * `prisma.$transaction`):
 *
 * 1. Read derived state for both searches.
 * 2. Determine the two userIds; acquire `SELECT … FOR UPDATE` locks on
 *    the User rows in deterministic order (lower id first) to prevent
 *    deadlocks if two propose attempts cross the same pair from
 *    opposite directions.
 * 3. Re-read both searches' derived state inside the transaction. If
 *    either is no longer `STARTED`, throw — the caller (run-matcher)
 *    treats this as "race lost" and falls back to a different
 *    candidate.
 * 4. Generate `matchId`.
 * 5. Insert one `PROPOSED` event in `PendingGameEvent` with snapshot
 *    fields.
 * 6. Insert one `MATCHED` event per search in `MatchmakingSearchEvent`,
 *    both referencing the new `matchId`.
 */
export async function proposePendingGame(
	searchAAttemptId: string,
	searchBAttemptId: string,
): Promise<DerivedMatchState> {
	return Sentry.startSpan(
		{ name: 'Matchmaking: propose pending game' },
		async () => {
			if (searchAAttemptId === searchBAttemptId) {
				throw new Error('proposePendingGame: cannot pair a search with itself');
			}

			const matchId = await prisma.$transaction(async (tx) => {
				// 1. Read initial state (outside the lock — used only to learn
				//    which two User rows to lock).
				const searchA = await getSearchAttempt(searchAAttemptId, tx);
				const searchB = await getSearchAttempt(searchBAttemptId, tx);
				if (!searchA || !searchB) {
					throw new Error(
						'proposePendingGame: one or both search attempts do not exist',
					);
				}
				if (searchA.userId === searchB.userId) {
					throw new Error(
						'proposePendingGame: both searches belong to the same user',
					);
				}

				// 2. Lock the two User rows in deterministic order to prevent
				//    deadlocks when two concurrent proposals touch the same pair
				//    from opposite directions.
				const [firstUserId, secondUserId] = [searchA.userId, searchB.userId]
					.slice()
					.sort();
				await tx.$queryRaw`SELECT id FROM "User" WHERE id = ${firstUserId} FOR UPDATE`;
				await tx.$queryRaw`SELECT id FROM "User" WHERE id = ${secondUserId} FOR UPDATE`;

				// 3. Re-derive state inside the lock. If either search has
				//    progressed past STARTED since the matcher chose it, abort.
				const refreshedA = await getSearchAttempt(searchAAttemptId, tx);
				const refreshedB = await getSearchAttempt(searchBAttemptId, tx);
				if (!refreshedA || refreshedA.status !== 'STARTED') {
					throw new Error(
						`proposePendingGame: search ${searchAAttemptId} is no longer STARTED (status=${refreshedA?.status ?? 'missing'})`,
					);
				}
				if (!refreshedB || refreshedB.status !== 'STARTED') {
					throw new Error(
						`proposePendingGame: search ${searchBAttemptId} is no longer STARTED (status=${refreshedB?.status ?? 'missing'})`,
					);
				}

				// 4. Generate the matchId.
				const id = randomUUID();

				// 5. Insert the PROPOSED event with full snapshot.
				await tx.pendingGameEvent.create({
					data: {
						matchId: id,
						type: 'PROPOSED',
						playerAId: refreshedA.userId,
						playerBId: refreshedB.userId,
						playerARating: refreshedA.rating,
						playerBRating: refreshedB.rating,
						searchAAttemptId: refreshedA.attemptId,
						searchBAttemptId: refreshedB.attemptId,
					},
				});

				// 6. Insert MATCHED events on both searches.
				await tx.matchmakingSearchEvent.createMany({
					data: [
						{
							attemptId: refreshedA.attemptId,
							userId: refreshedA.userId,
							type: 'MATCHED',
							matchId: id,
						},
						{
							attemptId: refreshedB.attemptId,
							userId: refreshedB.userId,
							type: 'MATCHED',
							matchId: id,
						},
					],
				});

				return id;
			});

			const state = await getMatchState(matchId);
			if (!state) {
				// Should be impossible — we just wrote PROPOSED inside a committed transaction.
				throw new Error(
					`proposePendingGame: failed to read back match ${matchId} after commit`,
				);
			}
			return state;
		},
	);
}

/**
 * Confirm a pending match on behalf of one player.
 *
 * - Throws if `userId` is not one of the two players.
 * - No-op (returns current state) if the user has already confirmed —
 *   makes the call safe for double-click / network retry.
 * - Throws if the match is already terminal (DECLINED/EXPIRED/PLAYED).
 * - Inside the transaction, after appending `CONFIRMED_BY`, re-reads
 *   the confirmedBy set. If both players are now represented, also
 *   appends `BOTH_CONFIRMED` so the client can dispatch on a single
 *   latest-event status.
 */
export async function confirmPendingGame(
	matchId: string,
	userId: string,
): Promise<DerivedMatchState> {
	return Sentry.startSpan(
		{ name: 'Matchmaking: confirm pending game' },
		async () => {
			const initial = await getMatchState(matchId);
			if (!initial) {
				throw new Error(`confirmPendingGame: match ${matchId} not found`);
			}
			if (userId !== initial.playerAId && userId !== initial.playerBId) {
				throw new Error(
					'confirmPendingGame: user is not a participant in this match',
				);
			}
			if (initial.confirmedBy.has(userId)) {
				// Idempotent for double-click / retry: same user has already confirmed.
				return initial;
			}
			if (TERMINAL_MATCH_STATUSES.has(initial.status)) {
				throw new Error(
					`confirmPendingGame: match ${matchId} is already terminal (status=${initial.status})`,
				);
			}

			await prisma.$transaction(async (tx) => {
				// Serialise concurrent confirms from the two players by locking
				// both User rows in deterministic order (same pattern as
				// proposePendingGame). Without this, under READ COMMITTED both
				// transactions would re-read their own CONFIRMED_BY insert only,
				// neither would observe both-confirmed, and neither would
				// synthesise the BOTH_CONFIRMED transition event — leaving the
				// match stuck at CONFIRMED_BY despite both players having
				// confirmed.
				const [firstUserId, secondUserId] = [
					initial.playerAId,
					initial.playerBId,
				]
					.slice()
					.sort();
				await tx.$queryRaw`SELECT id FROM "User" WHERE id = ${firstUserId} FOR UPDATE`;
				await tx.$queryRaw`SELECT id FROM "User" WHERE id = ${secondUserId} FOR UPDATE`;

				// Re-read inside the lock — another confirmer may have raced us
				// to the lock and already inserted both events.
				const preInsert = await getMatchState(matchId, tx);
				if (!preInsert) {
					throw new Error(
						`confirmPendingGame: match ${matchId} disappeared mid-transaction`,
					);
				}
				if (preInsert.confirmedBy.has(userId)) {
					// Lost the race to insert our own CONFIRMED_BY: an idempotent
					// retry from elsewhere got there first. Treat as success.
					return;
				}
				if (TERMINAL_MATCH_STATUSES.has(preInsert.status)) {
					throw new Error(
						`confirmPendingGame: match ${matchId} became terminal mid-transaction (status=${preInsert.status})`,
					);
				}

				await tx.pendingGameEvent.create({
					data: {
						matchId,
						type: 'CONFIRMED_BY',
						actingPlayerId: userId,
					},
				});

				const refreshed = await getMatchState(matchId, tx);
				if (!refreshed) {
					throw new Error(
						`confirmPendingGame: match ${matchId} disappeared mid-transaction`,
					);
				}

				if (
					refreshed.confirmedBy.has(refreshed.playerAId) &&
					refreshed.confirmedBy.has(refreshed.playerBId) &&
					refreshed.status !== 'BOTH_CONFIRMED'
				) {
					await tx.pendingGameEvent.create({
						data: {
							matchId,
							type: 'BOTH_CONFIRMED',
						},
					});
				}
			});

			const state = await getMatchState(matchId);
			if (!state) {
				throw new Error(
					`confirmPendingGame: failed to read back match ${matchId} after commit`,
				);
			}
			return state;
		},
	);
}

/**
 * Decline a pending match. Per design decision #7, both players must
 * re-queue — so we append `DECLINED` to the match and to both source
 * searches.
 */
export async function declinePendingGame(
	matchId: string,
	userId: string,
): Promise<DerivedMatchState> {
	return Sentry.startSpan(
		{ name: 'Matchmaking: decline pending game' },
		async () => {
			const initial = await getMatchState(matchId);
			if (!initial) {
				throw new Error(`declinePendingGame: match ${matchId} not found`);
			}
			if (userId !== initial.playerAId && userId !== initial.playerBId) {
				throw new Error(
					'declinePendingGame: user is not a participant in this match',
				);
			}
			if (TERMINAL_MATCH_STATUSES.has(initial.status)) {
				throw new Error(
					`declinePendingGame: match ${matchId} is already terminal (status=${initial.status})`,
				);
			}

			await prisma.$transaction(async (tx) => {
				await tx.pendingGameEvent.create({
					data: {
						matchId,
						type: 'DECLINED',
						actingPlayerId: userId,
					},
				});
				await tx.matchmakingSearchEvent.createMany({
					data: [
						{
							attemptId: initial.searchAAttemptId,
							userId: initial.playerAId,
							type: 'DECLINED',
							matchId,
						},
						{
							attemptId: initial.searchBAttemptId,
							userId: initial.playerBId,
							type: 'DECLINED',
							matchId,
						},
					],
				});
			});

			const state = await getMatchState(matchId);
			if (!state) {
				throw new Error(
					`declinePendingGame: failed to read back match ${matchId} after commit`,
				);
			}
			return state;
		},
	);
}

/**
 * If the match has been sitting in `PROPOSED` or `CONFIRMED_BY` for
 * longer than `PENDING_GAME_CONFIRM_WINDOW_SECONDS`, append `EXPIRED`
 * to the match and to both source searches. Returns the resulting
 * state, or `null` if the match is not stale (either terminal or
 * still within the window).
 *
 * Called inline from the polling path and from the scheduled tick.
 */
export async function expireIfStale(
	matchId: string,
	now: Date = new Date(),
): Promise<DerivedMatchState | null> {
	return Sentry.startSpan(
		{ name: 'Matchmaking: expire if stale' },
		async () => {
			const initial = await getMatchState(matchId);
			if (!initial) return null;
			if (TERMINAL_MATCH_STATUSES.has(initial.status)) return null;
			if (initial.status === 'BOTH_CONFIRMED') return null;

			const elapsedMs = now.getTime() - initial.proposedAt.getTime();
			if (elapsedMs < PENDING_GAME_CONFIRM_WINDOW_SECONDS * 1000) {
				return null;
			}

			await prisma.$transaction(async (tx) => {
				// Re-read state inside the transaction; if it has progressed to a
				// terminal status (or BOTH_CONFIRMED) since the pre-check, no-op.
				const refreshed = await getMatchState(matchId, tx);
				if (!refreshed) return;
				if (TERMINAL_MATCH_STATUSES.has(refreshed.status)) return;
				if (refreshed.status === 'BOTH_CONFIRMED') return;

				await tx.pendingGameEvent.create({
					data: { matchId, type: 'EXPIRED' },
				});
				await tx.matchmakingSearchEvent.createMany({
					data: [
						{
							attemptId: refreshed.searchAAttemptId,
							userId: refreshed.playerAId,
							type: 'EXPIRED',
							matchId,
						},
						{
							attemptId: refreshed.searchBAttemptId,
							userId: refreshed.playerBId,
							type: 'EXPIRED',
							matchId,
						},
					],
				});
			});

			return getMatchState(matchId);
		},
	);
}

/**
 * Convert a BOTH_CONFIRMED match into a recorded game result.
 *
 * Composition with `recordGame`: the existing `recordGame` runs its
 * own `prisma.$transaction` to write the `GameResult` + participants
 * and bump both users' `currentRating`. Nesting that inside a
 * surrounding interactive transaction is awkward in Prisma — passing
 * a `tx` client through to `recordGame` would require refactoring it.
 *
 * Pragmatic approach (per task notes): call `recordGame` first, then
 * run a SECOND `prisma.$transaction` that re-reads match state, throws
 * if it has progressed past `BOTH_CONFIRMED` (first-wins on a
 * conflicting submit), and appends `PLAYED` + `CONSUMED` events.
 *
 * KNOWN ORPHAN-RISK WINDOW: between the `recordGame` commit and the
 * event-write transaction, if the process crashes (or the second
 * transaction throws after `recordGame` succeeded), we end up with a
 * real `GameResult` row that no `PLAYED` event references. The
 * GameResult itself is correct — Elo math has been applied — but the
 * audit trail will show the match as still `BOTH_CONFIRMED`. Since
 * the matchmaking flow gates on `BOTH_CONFIRMED`, a retry will be
 * rejected by the first-wins check; manual reconciliation would be
 * required. Acceptable for v1 given internal-app traffic levels.
 */
export async function convertPendingGameToResult(
	matchId: string,
	reporterUserId: string,
	result: EloResult,
): Promise<{ gameResult: GameResult; matchState: DerivedMatchState }> {
	return Sentry.startSpan(
		{ name: 'Matchmaking: convert pending game to result' },
		async () => {
			const initial = await getMatchState(matchId);
			if (!initial) {
				throw new Error(
					`convertPendingGameToResult: match ${matchId} not found`,
				);
			}
			if (
				reporterUserId !== initial.playerAId &&
				reporterUserId !== initial.playerBId
			) {
				throw new Error(
					'convertPendingGameToResult: reporter is not a participant in this match',
				);
			}
			if (initial.status !== 'BOTH_CONFIRMED') {
				throw new Error(
					`convertPendingGameToResult: match ${matchId} is not BOTH_CONFIRMED (status=${initial.status})`,
				);
			}

			// 1. Record the game in its own transaction. This is the side-effect
			//    that opens the orphan-risk window described in the header
			//    comment above.
			const recorded = await recordGame({
				playerAId: initial.playerAId,
				playerBId: initial.playerBId,
				result,
			});

			// 2. Second transaction: re-read state to enforce first-wins, then
			//    append PLAYED on the match and CONSUMED on both searches.
			await prisma.$transaction(async (tx) => {
				const refreshed = await getMatchState(matchId, tx);
				if (!refreshed) {
					throw new Error(
						`convertPendingGameToResult: match ${matchId} disappeared mid-transaction`,
					);
				}
				if (refreshed.status !== 'BOTH_CONFIRMED') {
					throw new Error(
						`convertPendingGameToResult: match ${matchId} progressed past BOTH_CONFIRMED (status=${refreshed.status}); first-wins`,
					);
				}

				await tx.pendingGameEvent.create({
					data: {
						matchId,
						type: 'PLAYED',
						gameResultId: recorded.gameResult.id,
					},
				});
				await tx.matchmakingSearchEvent.createMany({
					data: [
						{
							attemptId: refreshed.searchAAttemptId,
							userId: refreshed.playerAId,
							type: 'CONSUMED',
							matchId,
						},
						{
							attemptId: refreshed.searchBAttemptId,
							userId: refreshed.playerBId,
							type: 'CONSUMED',
							matchId,
						},
					],
				});
			});

			const finalState = await getMatchState(matchId);
			if (!finalState) {
				throw new Error(
					`convertPendingGameToResult: failed to read back match ${matchId} after commit`,
				);
			}
			return { gameResult: recorded.gameResult, matchState: finalState };
		},
	);
}

// Re-export the derived state types for convenience at call sites that
// import lifecycle functions but not the state module directly.
export type { DerivedMatchState, DerivedSearchState };
