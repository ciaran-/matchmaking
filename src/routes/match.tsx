import { useUser } from '@clerk/clerk-react';
import type { GameParticipant, GameResult } from '@prisma/client';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { createFileRoute, useRouter } from '@tanstack/react-router';
import { createServerFn } from '@tanstack/react-start';
import * as Sentry from '@sentry/tanstackstart-react';
import { useEffect, useMemo, useState } from 'react';
import type { EloResult } from '@/lib/elo';

/**
 * `GameResult` with its participants eagerly loaded — matches the
 * `include: { participants: true }` used in `pollSearchStatusFn`. Avoids
 * pulling the `Prisma` namespace at runtime in this route file.
 */
type GameResultWithParticipants = GameResult & {
	participants: GameParticipant[];
};

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
 * if the search is MATCHED (or was MATCHED before its match terminated),
 * the associated `DerivedMatchState`. Also returns:
 *
 *   - `opponent`: the other player's `{ id, username, currentRating }`
 *     when a match is in play. Pulled separately rather than baked into
 *     `DerivedMatchState` so the matchmaking lib stays display-agnostic.
 *   - `gameResult`: the resulting `GameResult` (including participants)
 *     when the match has reached PLAYED. Lets the UI surface the result
 *     even when the opponent submitted first.
 *
 * If the match is found to be stale on read (PROPOSED/CONFIRMED_BY older
 * than the confirm window), inline-expires it and re-reads.
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
				const { prisma } = await import('@/db');

				let search = await getActiveSearchForUser(dbUser.id);
				let match: Awaited<ReturnType<typeof getMatchState>> = null;
				let matchIdForLookup: string | null = null;

				if (search?.status === 'MATCHED' && search.matchId) {
					// Inline expiry: if the match has been sitting unconfirmed past
					// the window, this writes EXPIRED events for the match and both
					// searches. `expireIfStale` returns null when the match is not
					// stale; either way we re-read state below.
					matchIdForLookup = search.matchId;
					await expireIfStale(search.matchId);
					// Re-read the search — its status may now be EXPIRED. Read the
					// match by its original id so the UI still sees the (now-EXPIRED)
					// match state even though the user's active search has cleared.
					search = await getActiveSearchForUser(dbUser.id);
					match = await getMatchState(matchIdForLookup);
				}

				// Look up opponent + gameResult (for display) when we have a match.
				let opponent: {
					id: string;
					username: string;
					currentRating: number;
				} | null = null;
				let gameResult: GameResultWithParticipants | null = null;

				if (match) {
					const opponentId =
						match.playerAId === dbUser.id ? match.playerBId : match.playerAId;
					const opp = await prisma.user.findUnique({
						where: { id: opponentId },
						select: { id: true, username: true, currentRating: true },
					});
					opponent = opp;

					if (match.gameResultId) {
						gameResult = await prisma.gameResult.findUnique({
							where: { id: match.gameResultId },
							include: { participants: true },
						});
					}
				}

				return { search, match, opponent, gameResult };
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

// ─────────────────────────────────────────────────────────────────────────────
// UI
// ─────────────────────────────────────────────────────────────────────────────

type PollData = Awaited<ReturnType<typeof pollSearchStatusFn>>;

type Phase =
	| 'idle'
	| 'searching'
	| 'match-proposed'
	| 'waiting-on-opponent'
	| 'play'
	| 'submit-result'
	| 'idle-with-message';

const TERMINAL_SEARCH_STATUSES = new Set([
	'CANCELLED',
	'ABANDONED',
	'EXPIRED',
	'DECLINED',
	'CONSUMED',
]);

/**
 * Compute the next UI phase from the latest poll payload + the user's
 * own DB id. Pure function — drives the `useEffect` that reconciles
 * server state into UI state. See plan §"UI" for the canonical state
 * diagram this implements.
 */
function derivePhase(
	poll: PollData | undefined,
	dbUserId: string | undefined,
	currentPhase: Phase,
): Phase {
	if (!poll || !dbUserId) return currentPhase;

	const { search, match } = poll;

	// No active search and no in-flight match → idle (or idle-with-message if
	// we're transitioning out of a non-idle phase via a terminal status).
	if (!search) {
		// Match exists but search is null: terminal-but-show-result paths.
		if (match) {
			if (match.status === 'PLAYED') return 'submit-result';
			if (match.status === 'DECLINED' || match.status === 'EXPIRED') {
				return 'idle-with-message';
			}
		}
		if (currentPhase === 'idle' || currentPhase === 'submit-result') {
			return currentPhase;
		}
		return 'idle-with-message';
	}

	// Search exists.
	if (TERMINAL_SEARCH_STATUSES.has(search.status)) {
		if (match?.status === 'PLAYED') return 'submit-result';
		return 'idle-with-message';
	}

	if (search.status === 'STARTED') return 'searching';

	if (search.status === 'MATCHED' && match) {
		switch (match.status) {
			case 'PROPOSED':
				return 'match-proposed';
			case 'CONFIRMED_BY':
				return match.confirmedBy.has(dbUserId)
					? 'waiting-on-opponent'
					: 'match-proposed';
			case 'BOTH_CONFIRMED':
				return 'play';
			case 'PLAYED':
				return 'submit-result';
			case 'DECLINED':
			case 'EXPIRED':
				return 'idle-with-message';
		}
	}

	return currentPhase;
}

/**
 * Render a friendly explanation for the `idle-with-message` banner
 * based on the latest poll payload.
 */
function explainTerminal(poll: PollData | undefined): string | null {
	if (!poll) return null;
	const search = poll.search;
	const match = poll.match;
	if (match) {
		if (match.status === 'DECLINED') return 'Match declined.';
		if (match.status === 'EXPIRED')
			return 'Match expired — confirmation window passed.';
	}
	if (search) {
		switch (search.status) {
			case 'CANCELLED':
				return 'Search cancelled.';
			case 'ABANDONED':
				return 'Search abandoned (inactive too long).';
			case 'EXPIRED':
				return 'Match expired — confirmation window passed.';
			case 'DECLINED':
				return 'Match declined.';
		}
	}
	return null;
}

function MatchPage() {
	const { isSignedIn, isLoaded, user } = useUser();
	const router = useRouter();
	const queryClient = useQueryClient();

	const [phase, setPhase] = useState<Phase>('idle');
	const [mutationError, setMutationError] = useState<string | null>(null);
	const [terminalMessage, setTerminalMessage] = useState<string | null>(null);

	// Poll while the user is in a non-terminal, non-idle phase. The mutation
	// success handlers also call `invalidateQueries` so the UI doesn't wait
	// up to 2s for the next tick after an action.
	const pollEnabled =
		isSignedIn === true &&
		phase !== 'idle' &&
		phase !== 'submit-result' &&
		phase !== 'idle-with-message';

	const pollQuery = useQuery({
		queryKey: ['matchmaking', 'status'],
		queryFn: () => pollSearchStatusFn(),
		refetchInterval: pollEnabled ? 2000 : false,
		enabled: pollEnabled,
	});

	// Reconcile (currentPhase, pollData) → nextPhase whenever new poll data
	// arrives. Also captures a terminal-state explanation for the banner.
	useEffect(() => {
		if (!pollQuery.data) return;
		const dbUserId =
			pollQuery.data.search?.userId ??
			pollQuery.data.match?.playerAId ??
			pollQuery.data.match?.playerBId;
		setPhase((current) => {
			const next = derivePhase(pollQuery.data, dbUserId, current);
			if (next === 'idle-with-message' && current !== 'idle-with-message') {
				setTerminalMessage(explainTerminal(pollQuery.data));
			}
			return next;
		});
	}, [pollQuery.data]);

	// Mutations. Each clears mutationError on settle, invalidates the poll on
	// success so the UI catches up immediately. `recordPendingGameResultFn`
	// additionally invalidates the router so any open /league view picks up
	// the new game.
	const invalidatePoll = () =>
		queryClient.invalidateQueries({ queryKey: ['matchmaking', 'status'] });

	const startMutation = useMutation({
		mutationFn: () => startSearchFn(),
		onSuccess: () => {
			setTerminalMessage(null);
			setPhase('searching');
			invalidatePoll();
		},
		onError: (e) =>
			setMutationError(
				(e as { message?: string }).message ?? 'Failed to start search',
			),
	});

	const cancelMutation = useMutation({
		mutationFn: () => cancelSearchFn(),
		onSuccess: () => {
			setPhase('idle');
			setTerminalMessage(null);
			invalidatePoll();
		},
		onError: (e) =>
			setMutationError(
				(e as { message?: string }).message ?? 'Failed to cancel',
			),
	});

	const confirmMutation = useMutation({
		mutationFn: (matchId: string) => confirmMatchFn({ data: { matchId } }),
		onSuccess: () => invalidatePoll(),
		onError: (e) =>
			setMutationError(
				(e as { message?: string }).message ?? 'Failed to confirm',
			),
	});

	const declineMutation = useMutation({
		mutationFn: (matchId: string) => declineMatchFn({ data: { matchId } }),
		onSuccess: () => {
			setPhase('idle');
			setTerminalMessage('You declined the match.');
			invalidatePoll();
		},
		onError: (e) =>
			setMutationError(
				(e as { message?: string }).message ?? 'Failed to decline',
			),
	});

	const recordResultMutation = useMutation({
		mutationFn: (input: { matchId: string; result: EloResult }) =>
			recordPendingGameResultFn({ data: input }),
		onSuccess: () => {
			setPhase('submit-result');
			invalidatePoll();
			router.invalidate();
		},
		onError: (e) =>
			setMutationError(
				(e as { message?: string }).message ?? 'Failed to record result',
			),
	});

	// Reset to idle and clear any banner / error state. Used by both the
	// "Find another match" button and the dismissal in the idle-with-message
	// banner.
	const resetToIdle = () => {
		setPhase('idle');
		setTerminalMessage(null);
		setMutationError(null);
		queryClient.setQueryData(['matchmaking', 'status'], undefined);
	};

	const handleStart = () => {
		setMutationError(null);
		startMutation.mutate();
	};

	const handleCancel = () => {
		setMutationError(null);
		cancelMutation.mutate();
	};

	const handleConfirm = (matchId: string) => {
		setMutationError(null);
		confirmMutation.mutate(matchId);
	};

	const handleDecline = (matchId: string) => {
		setMutationError(null);
		declineMutation.mutate(matchId);
	};

	const handleSubmitResult = (matchId: string, result: EloResult) => {
		setMutationError(null);
		recordResultMutation.mutate({ matchId, result });
	};

	if (!isLoaded) {
		return <div className="p-4 text-white">Loading…</div>;
	}
	if (!isSignedIn) {
		return <div className="p-4 text-white">Sign in to find a match.</div>;
	}

	const poll = pollQuery.data;
	const match = poll?.match ?? null;
	const opponent = poll?.opponent ?? null;
	const gameResult = poll?.gameResult ?? null;
	// `user` here is the Clerk user — we only need the DB user id, which
	// lives on the polled search/match payload, so we don't have to call
	// out to the server for it. Fall back to `null` until the first poll
	// completes; mutations don't need it.
	const dbUserId =
		poll?.search?.userId ??
		(match && (user?.id === match.playerAId ? match.playerAId : null)) ??
		null;

	return (
		<div className="min-h-screen bg-gradient-to-b from-slate-900 via-slate-800 to-slate-900 text-white">
			<section className="py-12 px-6 text-center">
				<h1 className="text-5xl md:text-6xl font-black [letter-spacing:-0.06em]">
					<span className="text-gray-300">MATCH</span>
					<span className="bg-gradient-to-r from-cyan-400 to-blue-400 bg-clip-text text-transparent">
						MAKING
					</span>
				</h1>
				<p className="mt-3 text-sm uppercase tracking-widest text-slate-400">
					{phaseLabel(phase)}
				</p>
			</section>

			<section className="max-w-2xl mx-auto px-6 pb-16">
				{mutationError && (
					<div className="mb-4 rounded-lg border border-red-500/40 bg-red-500/10 px-4 py-3 text-sm text-red-300">
						{mutationError}
					</div>
				)}

				{phase === 'idle' && (
					<IdleSection
						onStart={handleStart}
						disabled={startMutation.isPending}
					/>
				)}

				{phase === 'idle-with-message' && (
					<IdleSection
						onStart={handleStart}
						disabled={startMutation.isPending}
						banner={terminalMessage}
						onDismiss={resetToIdle}
					/>
				)}

				{phase === 'searching' && poll?.search && (
					<SearchingSection
						startedAt={poll.search.startedAt}
						rating={poll.search.rating}
						onCancel={handleCancel}
						cancelling={cancelMutation.isPending}
					/>
				)}

				{phase === 'match-proposed' && match && (
					<MatchProposedSection
						match={match}
						opponent={opponent}
						dbUserId={dbUserId}
						onConfirm={() => handleConfirm(match.matchId)}
						onDecline={() => handleDecline(match.matchId)}
						confirming={confirmMutation.isPending}
						declining={declineMutation.isPending}
					/>
				)}

				{phase === 'waiting-on-opponent' && match && opponent && (
					<WaitingOnOpponentSection opponent={opponent} />
				)}

				{phase === 'play' && match && opponent && (
					<PlaySection
						opponent={opponent}
						onSubmit={(result) => handleSubmitResult(match.matchId, result)}
						submitting={recordResultMutation.isPending}
					/>
				)}

				{phase === 'submit-result' && match && (
					<SubmitResultSection
						match={match}
						gameResult={gameResult}
						opponent={opponent}
						dbUserId={dbUserId}
						onReset={resetToIdle}
					/>
				)}
			</section>
		</div>
	);
}

function phaseLabel(phase: Phase): string {
	switch (phase) {
		case 'idle':
			return 'Ready';
		case 'idle-with-message':
			return 'Ready';
		case 'searching':
			return 'Searching';
		case 'match-proposed':
			return 'Match found';
		case 'waiting-on-opponent':
			return 'Waiting on opponent';
		case 'play':
			return 'Play';
		case 'submit-result':
			return 'Result';
	}
}

// ─────────────────────────────────────────────────────────────────────────────
// Phase sections — kept inline rather than extracted to keep the state machine
// readable in one place. Each section is a thin presentational shell.
// ─────────────────────────────────────────────────────────────────────────────

function IdleSection({
	onStart,
	disabled,
	banner,
	onDismiss,
}: {
	onStart: () => void;
	disabled: boolean;
	banner?: string | null;
	onDismiss?: () => void;
}) {
	return (
		<div className="flex flex-col items-center gap-6">
			{banner && (
				<div className="w-full rounded-lg border border-amber-500/40 bg-amber-500/10 px-4 py-3 text-sm text-amber-200 flex items-center justify-between gap-3">
					<span>{banner}</span>
					{onDismiss && (
						<button
							type="button"
							onClick={onDismiss}
							className="text-amber-300/80 hover:text-amber-100 text-xs uppercase tracking-wider"
						>
							Dismiss
						</button>
					)}
				</div>
			)}
			<p className="text-slate-300 text-center">
				Enter the queue and we'll pair you with someone close to your rating.
			</p>
			<button
				type="button"
				onClick={onStart}
				disabled={disabled}
				className="bg-gradient-to-r from-cyan-500 to-blue-500 hover:from-cyan-400 hover:to-blue-400 disabled:opacity-50 disabled:cursor-not-allowed text-white font-semibold px-6 py-3 rounded-lg transition-all shadow-lg"
			>
				{disabled ? 'Starting…' : 'Find a match'}
			</button>
		</div>
	);
}

function SearchingSection({
	startedAt,
	rating,
	onCancel,
	cancelling,
}: {
	startedAt: Date;
	rating: number;
	onCancel: () => void;
	cancelling: boolean;
}) {
	const elapsed = useElapsedSeconds(startedAt);
	return (
		<div className="flex flex-col items-center gap-6">
			<div className="flex flex-col items-center gap-2">
				<div className="w-10 h-10 rounded-full border-2 border-cyan-400 border-t-transparent animate-spin" />
				<p className="text-slate-200 text-lg">Searching for an opponent…</p>
				<p className="text-slate-400 text-sm">
					Your rating: {rating} · Elapsed: {elapsed}s
				</p>
			</div>
			<button
				type="button"
				onClick={onCancel}
				disabled={cancelling}
				className="bg-slate-700 hover:bg-slate-600 disabled:opacity-50 text-white font-medium px-5 py-2 rounded-lg transition-colors"
			>
				{cancelling ? 'Cancelling…' : 'Cancel search'}
			</button>
		</div>
	);
}

function MatchProposedSection({
	match,
	opponent,
	dbUserId,
	onConfirm,
	onDecline,
	confirming,
	declining,
}: {
	match: NonNullable<PollData['match']>;
	opponent: PollData['opponent'];
	dbUserId: string | null;
	onConfirm: () => void;
	onDecline: () => void;
	confirming: boolean;
	declining: boolean;
}) {
	// Match snapshot ratings are display-only — use them for the delta so
	// the UI matches what the matcher saw when it paired the players.
	const myRating =
		dbUserId === match.playerAId ? match.playerARating : match.playerBRating;
	const oppRating =
		dbUserId === match.playerAId ? match.playerBRating : match.playerARating;
	const delta = oppRating - myRating;
	return (
		<div className="flex flex-col items-center gap-6 rounded-xl border border-slate-700 bg-slate-800/60 px-6 py-8">
			<p className="text-slate-300 uppercase text-xs tracking-widest">
				Match found
			</p>
			<div className="flex flex-col items-center gap-1">
				<p className="text-3xl font-bold">{opponent?.username ?? '…'}</p>
				<p className="text-slate-400">
					Rating: {oppRating}{' '}
					<span
						className={
							delta === 0
								? 'text-slate-400'
								: delta > 0
									? 'text-cyan-300'
									: 'text-amber-300'
						}
					>
						({delta >= 0 ? `+${delta}` : delta})
					</span>
				</p>
			</div>
			<div className="flex gap-3">
				<button
					type="button"
					onClick={onConfirm}
					disabled={confirming || declining}
					className="bg-gradient-to-r from-cyan-500 to-blue-500 hover:from-cyan-400 hover:to-blue-400 disabled:opacity-50 text-white font-semibold px-5 py-2 rounded-lg shadow-md"
				>
					{confirming ? 'Accepting…' : 'Accept'}
				</button>
				<button
					type="button"
					onClick={onDecline}
					disabled={confirming || declining}
					className="bg-slate-700 hover:bg-slate-600 disabled:opacity-50 text-white font-medium px-5 py-2 rounded-lg"
				>
					{declining ? 'Declining…' : 'Decline'}
				</button>
			</div>
		</div>
	);
}

function WaitingOnOpponentSection({
	opponent,
}: {
	opponent: NonNullable<PollData['opponent']>;
}) {
	return (
		<div className="flex flex-col items-center gap-4 rounded-xl border border-slate-700 bg-slate-800/60 px-6 py-8">
			<div className="w-10 h-10 rounded-full border-2 border-cyan-400 border-t-transparent animate-spin" />
			<p className="text-slate-200">
				Waiting for <span className="font-semibold">{opponent.username}</span>{' '}
				to confirm…
			</p>
		</div>
	);
}

function PlaySection({
	opponent,
	onSubmit,
	submitting,
}: {
	opponent: NonNullable<PollData['opponent']>;
	onSubmit: (result: EloResult) => void;
	submitting: boolean;
}) {
	return (
		<div className="flex flex-col items-center gap-6 rounded-xl border border-slate-700 bg-slate-800/60 px-6 py-8">
			<div className="text-center">
				<p className="text-slate-300 uppercase text-xs tracking-widest">
					Now playing
				</p>
				<p className="text-2xl font-bold mt-1">vs {opponent.username}</p>
				<p className="text-slate-400 text-sm mt-1">
					Rating {opponent.currentRating}
				</p>
			</div>
			<p className="text-slate-300 text-sm">
				Go play. When you're done, report the result:
			</p>
			<div className="flex flex-wrap justify-center gap-3">
				<button
					type="button"
					onClick={() => onSubmit('A')}
					disabled={submitting}
					className="bg-gradient-to-r from-cyan-500 to-blue-500 hover:from-cyan-400 hover:to-blue-400 disabled:opacity-50 text-white font-semibold px-5 py-2 rounded-lg shadow-md"
				>
					I won
				</button>
				<button
					type="button"
					onClick={() => onSubmit('draw')}
					disabled={submitting}
					className="bg-slate-700 hover:bg-slate-600 disabled:opacity-50 text-white font-medium px-5 py-2 rounded-lg"
				>
					Draw
				</button>
				<button
					type="button"
					onClick={() => onSubmit('B')}
					disabled={submitting}
					className="bg-slate-700 hover:bg-slate-600 disabled:opacity-50 text-white font-medium px-5 py-2 rounded-lg"
				>
					Opponent won
				</button>
			</div>
		</div>
	);
}

function SubmitResultSection({
	match,
	gameResult,
	opponent,
	dbUserId,
	onReset,
}: {
	match: NonNullable<PollData['match']>;
	gameResult: PollData['gameResult'];
	opponent: PollData['opponent'];
	dbUserId: string | null;
	onReset: () => void;
}) {
	// Derive outcome + rating change from the GameResult's participants.
	// participants list is included in the poll response (see
	// `pollSearchStatusFn`). When the opponent submitted first this is the
	// only place the reporter can see what happened.
	const myParticipant = gameResult?.participants.find(
		(p) => p.userId === dbUserId,
	);
	const oppParticipant = gameResult?.participants.find(
		(p) => p.userId !== dbUserId,
	);

	const outcomeLabel = useMemo(() => {
		if (!gameResult) return 'Result recorded';
		// teamAScore vs teamBScore — match.playerAId is team A by convention.
		if (gameResult.teamAScore === gameResult.teamBScore) return 'Draw';
		const playerAWon = gameResult.teamAScore > gameResult.teamBScore;
		const youArePlayerA = dbUserId === match.playerAId;
		return playerAWon === youArePlayerA ? 'You won' : 'Opponent won';
	}, [gameResult, dbUserId, match.playerAId]);

	return (
		<div className="flex flex-col items-center gap-6 rounded-xl border border-slate-700 bg-slate-800/60 px-6 py-8">
			<p className="text-slate-300 uppercase text-xs tracking-widest">Result</p>
			<p className="text-3xl font-bold">{outcomeLabel}</p>
			{myParticipant && (
				<div className="flex flex-col items-center gap-1 text-slate-300 text-sm">
					<p>
						Your rating: {myParticipant.ratingBefore} →{' '}
						<span className="font-semibold text-white">
							{myParticipant.ratingAfter}
						</span>{' '}
						<span
							className={
								myParticipant.ratingChange > 0
									? 'text-cyan-300'
									: myParticipant.ratingChange < 0
										? 'text-amber-300'
										: 'text-slate-400'
							}
						>
							({myParticipant.ratingChange >= 0 ? '+' : ''}
							{myParticipant.ratingChange})
						</span>
					</p>
					{oppParticipant && opponent && (
						<p className="text-slate-400">
							{opponent.username}: {oppParticipant.ratingBefore} →{' '}
							{oppParticipant.ratingAfter} (
							{oppParticipant.ratingChange >= 0 ? '+' : ''}
							{oppParticipant.ratingChange})
						</p>
					)}
				</div>
			)}
			<button
				type="button"
				onClick={onReset}
				className="bg-gradient-to-r from-cyan-500 to-blue-500 hover:from-cyan-400 hover:to-blue-400 text-white font-semibold px-5 py-2 rounded-lg shadow-md"
			>
				Find another match
			</button>
		</div>
	);
}

/**
 * Tick a counter once per second to drive the elapsed-time readout in
 * the searching phase. Cheap: a single `setInterval` per active search.
 */
function useElapsedSeconds(since: Date): number {
	const [now, setNow] = useState(() => Date.now());
	useEffect(() => {
		const id = setInterval(() => setNow(Date.now()), 1000);
		return () => clearInterval(id);
	}, []);
	return Math.max(0, Math.floor((now - new Date(since).getTime()) / 1000));
}
