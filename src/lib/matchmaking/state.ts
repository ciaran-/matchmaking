// Server-only module — do not import from client-side code.

import type {
	MatchmakingSearchEvent,
	MatchmakingSearchEventType,
	PendingGameEvent,
	PendingGameEventType,
	Prisma,
	PrismaClient,
} from '@prisma/client';
import { prisma } from '@/db';

/**
 * Accepts either the singleton Prisma client or a transaction client
 * (`tx` inside `prisma.$transaction`). This lets callers run derivation
 * reads inside the same transaction as their writes — important for
 * propose / confirm / record paths that mix derivation with appends.
 */
export type DbClient = PrismaClient | Prisma.TransactionClient;

/**
 * Derived current state of a single search attempt. All fields come from
 * the event log: `rating`/`startedAt` from the STARTED row, the rest
 * from the latest row for the attempt.
 */
export interface DerivedSearchState {
	attemptId: string;
	userId: string;
	rating: number;
	startedAt: Date;
	status: MatchmakingSearchEventType;
	matchId: string | null;
	latestEventAt: Date;
}

/**
 * Derived current state of a single match proposal. Static facts
 * (players, ratings, source searches) come from the PROPOSED row;
 * `status` is the latest event's type; `confirmedBy` is the set of
 * actingPlayerIds from every CONFIRMED_BY event; `gameResultId` is
 * captured from a PLAYED event if present.
 */
export interface DerivedMatchState {
	matchId: string;
	playerAId: string;
	playerBId: string;
	playerARating: number;
	playerBRating: number;
	searchAAttemptId: string;
	searchBAttemptId: string;
	proposedAt: Date;
	status: PendingGameEventType;
	confirmedBy: Set<string>;
	gameResultId: string | null;
	latestEventAt: Date;
}

/**
 * Build a `DerivedSearchState` from the STARTED event (which supplies
 * `rating` + `startedAt`) and the latest event for the attempt (which
 * supplies the current `status`, `matchId`, and `latestEventAt`).
 */
function toDerivedSearchState(
	started: MatchmakingSearchEvent,
	latest: MatchmakingSearchEvent,
): DerivedSearchState {
	if (started.rating === null) {
		// Schema invariant: STARTED events always carry a rating snapshot.
		throw new Error(
			`Invariant violation: STARTED event ${started.id} has null rating`,
		);
	}
	return {
		attemptId: started.attemptId,
		userId: started.userId,
		rating: started.rating,
		startedAt: started.createdAt,
		status: latest.type,
		matchId: latest.matchId,
		latestEventAt: latest.createdAt,
	};
}

/**
 * Returns the active search attempt for a user, or `null` if the user
 * has no events or their latest event is terminal.
 *
 * "Active" means the latest event is STARTED or MATCHED. Terminal
 * statuses (CANCELLED, ABANDONED, DECLINED, EXPIRED, CONSUMED) yield
 * `null` — the user is no longer in any pipeline.
 */
export async function getActiveSearchForUser(
	userId: string,
	client: DbClient = prisma,
): Promise<DerivedSearchState | null> {
	const latest = await client.matchmakingSearchEvent.findFirst({
		where: { userId },
		orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
	});
	if (!latest) return null;

	const ACTIVE_STATUSES: MatchmakingSearchEventType[] = ['STARTED', 'MATCHED'];
	if (!ACTIVE_STATUSES.includes(latest.type)) return null;

	// Fetch the STARTED row for rating + startedAt unless the latest IS the STARTED row.
	const started =
		latest.type === 'STARTED'
			? latest
			: await client.matchmakingSearchEvent.findFirst({
					where: { attemptId: latest.attemptId, type: 'STARTED' },
					orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
				});

	if (!started) {
		throw new Error(
			`Invariant violation: attempt ${latest.attemptId} has no STARTED event`,
		);
	}

	return toDerivedSearchState(started, latest);
}

/**
 * Returns every active (`STARTED`-as-latest) search attempt across all
 * users. Used by the matcher.
 *
 * Implementation: `DISTINCT ON ("attemptId")` over the event log to get
 * the latest row per attempt in one round-trip, filtered to `STARTED`
 * (these are the rows where STARTED IS the latest event — i.e. the
 * attempt has not progressed). Because of that filter, the latest row
 * and the STARTED row are the same row, so no second query is needed.
 */
export async function getActiveSearches(
	client: DbClient = prisma,
): Promise<DerivedSearchState[]> {
	const rows = await client.$queryRaw<MatchmakingSearchEvent[]>`
		SELECT DISTINCT ON ("attemptId") *
		FROM "MatchmakingSearchEvent"
		ORDER BY "attemptId", "createdAt" DESC, "id" DESC
	`;

	return rows
		.filter((r) => r.type === 'STARTED')
		.map((r) => toDerivedSearchState(r, r));
}

/**
 * Returns the derived state of a match proposal, or `null` if no
 * PROPOSED event exists for the given matchId.
 *
 * Reads every event for the match in chronological order, then:
 * - The PROPOSED event supplies the static facts (players, snapshots,
 *   source search refs).
 * - The latest event's `type` is the current `status`.
 * - `confirmedBy` accumulates every `CONFIRMED_BY` event's
 *   `actingPlayerId`.
 * - `gameResultId` is captured from the `PLAYED` event if present.
 */
export async function getMatchState(
	matchId: string,
	client: DbClient = prisma,
): Promise<DerivedMatchState | null> {
	const events = await client.pendingGameEvent.findMany({
		where: { matchId },
		orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
	});

	if (events.length === 0) return null;

	const proposed = events.find((e) => e.type === 'PROPOSED');
	if (!proposed) return null;

	if (
		!proposed.playerAId ||
		!proposed.playerBId ||
		proposed.playerARating === null ||
		proposed.playerBRating === null ||
		!proposed.searchAAttemptId ||
		!proposed.searchBAttemptId
	) {
		throw new Error(
			`Invariant violation: PROPOSED event ${proposed.id} is missing required fields`,
		);
	}

	const confirmedBy = new Set<string>();
	let gameResultId: string | null = null;
	for (const e of events) {
		if (e.type === 'CONFIRMED_BY' && e.actingPlayerId) {
			confirmedBy.add(e.actingPlayerId);
		}
		if (e.type === 'PLAYED' && e.gameResultId) {
			gameResultId = e.gameResultId;
		}
	}

	const latest = events[events.length - 1] as PendingGameEvent;

	return {
		matchId,
		playerAId: proposed.playerAId,
		playerBId: proposed.playerBId,
		playerARating: proposed.playerARating,
		playerBRating: proposed.playerBRating,
		searchAAttemptId: proposed.searchAAttemptId,
		searchBAttemptId: proposed.searchBAttemptId,
		proposedAt: proposed.createdAt,
		status: latest.type,
		confirmedBy,
		gameResultId,
		latestEventAt: latest.createdAt,
	};
}

/**
 * Returns the `matchId`s of pending matches whose latest event is
 * `PROPOSED` or `CONFIRMED_BY` AND whose `PROPOSED.createdAt` is older
 * than `staleAfterSeconds` seconds ago.
 *
 * Used by the scheduled tick to find pending matches that need to be
 * swept by `expireIfStale`. The hot path expires individually on poll;
 * this is the backstop for matches where neither player is polling
 * (both walked away).
 *
 * Implementation: `DISTINCT ON ("matchId")` over the event log to pick
 * the most recent event per match (with an `id` tiebreaker matching the
 * style used elsewhere in this file), then filter to the
 * `PROPOSED`/`CONFIRMED_BY` cases whose PROPOSED row's `createdAt` is
 * older than the cutoff.
 */
export async function getStaleMatchIds(
	staleAfterSeconds: number,
	client: DbClient = prisma,
): Promise<string[]> {
	const cutoff = new Date(Date.now() - staleAfterSeconds * 1000);
	const rows = await client.$queryRaw<
		{ matchId: string; type: string; proposedAt: Date }[]
	>`
		SELECT "matchId", "type"::text AS "type", "proposedAt"
		FROM (
			SELECT DISTINCT ON ("matchId")
				"matchId",
				"type",
				(SELECT MIN("createdAt") FROM "PendingGameEvent" p2
					WHERE p2."matchId" = p1."matchId" AND p2."type" = 'PROPOSED') AS "proposedAt"
			FROM "PendingGameEvent" p1
			ORDER BY "matchId", "createdAt" DESC, "id" DESC
		) latest
		WHERE "type" IN ('PROPOSED', 'CONFIRMED_BY')
			AND "proposedAt" IS NOT NULL
			AND "proposedAt" < ${cutoff}
	`;
	return rows.map((r) => r.matchId);
}

/**
 * Returns the derived state of a specific search attempt, regardless of
 * whether it's active or terminal. Returns `null` if no events exist
 * for the attempt.
 */
export async function getSearchAttempt(
	attemptId: string,
	client: DbClient = prisma,
): Promise<DerivedSearchState | null> {
	const events = await client.matchmakingSearchEvent.findMany({
		where: { attemptId },
		orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
	});

	if (events.length === 0) return null;

	const started = events.find((e) => e.type === 'STARTED');
	if (!started) {
		throw new Error(
			`Invariant violation: attempt ${attemptId} has no STARTED event`,
		);
	}

	const latest = events[events.length - 1] as MatchmakingSearchEvent;
	return toDerivedSearchState(started, latest);
}
