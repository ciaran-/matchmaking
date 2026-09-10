import { Link } from '@tanstack/react-router';
import { Button } from '@/components/storybook/button';
import type { GameOutcome } from '@/lib/game-outcome';
import type { MatchHistoryRow } from '@/lib/player-match-history';

export interface MatchHistoryProps {
	/** Rows accumulated so far, newest first. `undefined` while first loading. */
	rows: MatchHistoryRow[] | undefined;
	isLoading: boolean;
	error?: { message?: string };
	/** Whether a further page exists — drives the "Load more" button. */
	hasMore: boolean;
	/** Omit to render without a "Load more" control (e.g. no pagination wired up yet). */
	onLoadMore?: () => void;
	/** Distinct from `isLoading`: true while fetching an additional page. */
	isLoadingMore?: boolean;
}

const OUTCOME_LABEL: Record<GameOutcome, string> = {
	win: 'Win',
	loss: 'Loss',
	draw: 'Draw',
};

const OUTCOME_BADGE: Record<GameOutcome, string> = {
	win: 'text-emerald-400 border-emerald-400/30 bg-emerald-400/10',
	loss: 'text-red-400 border-red-400/30 bg-red-400/10',
	draw: 'text-slate-400 border-slate-400/30 bg-slate-400/10',
};

function formatRatingChange(change: number): string {
	if (change > 0) return `+${change}`;
	return String(change);
}

function formatPlayedAt(iso: string): string {
	return new Date(iso).toLocaleDateString(undefined, {
		year: 'numeric',
		month: 'short',
		day: 'numeric',
	});
}

export function MatchHistory({
	rows,
	isLoading,
	error,
	hasMore,
	onLoadMore,
	isLoadingMore,
}: MatchHistoryProps) {
	if (error && !rows) {
		return (
			<Frame>
				<p className="mt-3 text-sm text-slate-400">
					Couldn&apos;t load match history.
				</p>
			</Frame>
		);
	}

	if (isLoading && !rows) {
		return (
			<Frame>
				<p className="mt-3 text-sm text-slate-400">Loading…</p>
			</Frame>
		);
	}

	if (!rows || rows.length === 0) {
		return (
			<Frame>
				<p className="mt-3 text-sm text-slate-400">No games played yet.</p>
			</Frame>
		);
	}

	return (
		<Frame>
			<ul className="mt-4 flex flex-col gap-2">
				{rows.map((row) => (
					<li
						key={row.gameResultId}
						className="flex items-center justify-between gap-4 rounded-lg border border-slate-700 bg-slate-900/40 px-4 py-3"
					>
						<div className="flex items-center gap-3 min-w-0">
							<span
								className={`shrink-0 rounded-md border px-2 py-0.5 text-xs font-semibold uppercase tracking-wide ${OUTCOME_BADGE[row.outcome]}`}
							>
								{OUTCOME_LABEL[row.outcome]}
							</span>
							<div className="min-w-0">
								<p className="truncate text-sm text-slate-100">
									vs{' '}
									<Link
										to="/player/$username"
										params={{ username: row.opponentUsername }}
										className="text-cyan-400 hover:text-cyan-300 hover:underline"
									>
										{row.opponentUsername}
									</Link>
								</p>
								<p className="text-xs text-slate-500">
									{formatPlayedAt(row.playedAt)}
								</p>
							</div>
						</div>

						<div className="shrink-0 text-right">
							<p
								className={`text-sm font-semibold ${
									row.ratingChange > 0
										? 'text-emerald-400'
										: row.ratingChange < 0
											? 'text-red-400'
											: 'text-slate-400'
								}`}
							>
								{formatRatingChange(row.ratingChange)}
							</p>
							<p className="text-xs text-slate-500">{row.ratingAfter}</p>
						</div>
					</li>
				))}
			</ul>

			{hasMore && onLoadMore && (
				<div className="mt-4 flex justify-center">
					<Button
						variant="secondary"
						size="small"
						onClick={onLoadMore}
						disabled={isLoadingMore}
					>
						{isLoadingMore ? 'Loading…' : 'Load more'}
					</Button>
				</div>
			)}
		</Frame>
	);
}

function Frame({ children }: { children: React.ReactNode }) {
	return (
		<section className="rounded-xl border border-slate-700 bg-slate-800/60 px-6 py-5">
			<h2 className="text-xs uppercase tracking-widest text-slate-400">
				Match history
			</h2>
			{children}
		</section>
	);
}
