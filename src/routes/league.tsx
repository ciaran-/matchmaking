import { useQuery } from '@tanstack/react-query';
import { createFileRoute, Link, useRouter } from '@tanstack/react-router';
import { createServerFn } from '@tanstack/react-start';
import { PlusCircle } from 'lucide-react';
import { useId, useState } from 'react';
import { SignInGate } from '@/components/SignInGate';
import { Button } from '@/components/storybook/button';
import { Dialog } from '@/components/storybook/dialog';
import { RadioGroup } from '@/components/storybook/radio-group';
import { authenticatedUser } from '@/lib/auth';
import { canActOnGame } from '@/lib/authorization';
import type { EloResult } from '@/lib/elo';
import { getLeaderboard, getPlayerRank, pageForRank } from '@/lib/leaderboard';
import { recordGame } from '@/lib/record-game';
import { userFacingError } from '@/lib/user-facing-errors';

const getLeaguePlacesFn = createServerFn({ method: 'GET' })
	.inputValidator(
		(data: { page?: number; search?: string } | undefined) => data ?? {},
	)
	.handler(async ({ data }) => {
		// Delegates to the same lib read that backs GET /api/v1/leaderboard, so
		// the page and the API cannot disagree. It also counts outcomes in the
		// database rather than shipping every participation row here to be
		// tallied in the browser.
		return getLeaderboard({ page: data.page, search: data.search });
	});

/**
 * The signed-in user's rank, for the "jump to my rank" affordance.
 * POST because it performs an auth check.
 */
const getMyRankFn = createServerFn({ method: 'POST' }).handler(async () => {
	const user = await authenticatedUser();
	return getPlayerRank(user.id);
});

export const recordGameFn = createServerFn({ method: 'POST' })
	.inputValidator(
		(data: { playerAId: string; playerBId: string; result: EloResult }) => data,
	)
	.handler(async ({ data }) => {
		const user = await authenticatedUser();

		// Same rule as `POST /api/v1/games` — enforced here too, because
		// both paths share the `recordGame` core and leaving either one
		// permissive would make the restriction cosmetic.
		if (!canActOnGame(user, data)) {
			throw new Error('You are not a participant in this match');
		}

		return recordGame(data);
	});

export const Route = createFileRoute('/league')({
	ssr: 'data-only',
	component: LeagueTable,
	// No loader: the table is now paged and searchable, so it is fetched
	// client-side and refetches as those change.
});

type Player = { id: string; username: string };

interface RecordGameModalProps {
	players: Player[];
	/** The signed-in user's row, or null if it could not be synced. */
	currentUser: { id: string; role: string } | null;
	onClose: () => void;
	onSuccess: () => void;
}

function RecordGameModal({
	players,
	currentUser,
	onClose,
	onSuccess,
}: RecordGameModalProps) {
	const playerASelectId = useId();
	const playerBSelectId = useId();
	// Recording is restricted to games you played in; admins may record
	// anyone's (see `canActOnGame`). For an ordinary player there is no
	// choice to make about player A — it is them — so the UI states that
	// rather than offering a dropdown whose other options would 403.
	const canRecordForOthers = currentUser?.role === 'ADMIN';
	const [playerAId, setPlayerAId] = useState(
		canRecordForOthers ? '' : (currentUser?.id ?? ''),
	);
	const [playerBId, setPlayerBId] = useState('');
	const [result, setResult] = useState<EloResult>('A');
	const [submitting, setSubmitting] = useState(false);
	const [error, setError] = useState<string | null>(null);

	const playerAUsername = players.find((p) => p.id === playerAId)?.username;
	const playerBUsername = players.find((p) => p.id === playerBId)?.username;

	async function handleSubmit() {
		if (!playerAId || !playerBId) return;
		setSubmitting(true);
		setError(null);
		try {
			await recordGameFn({ data: { playerAId, playerBId, result } });
			onSuccess();
		} catch (e) {
			setError(
				userFacingError(e, "Couldn't record the game. Please try again."),
			);
		} finally {
			setSubmitting(false);
		}
	}

	return (
		<div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm">
			<div
				role="dialog"
				aria-modal="true"
				aria-label="Record Game Result"
				className="w-full max-w-md mx-4"
				onKeyDown={(e) => e.key === 'Escape' && onClose()}
			>
				<Dialog
					title="Record Game Result"
					footer={
						<div className="flex justify-end gap-3">
							<Button variant="secondary" onClick={onClose}>
								Cancel
							</Button>
							<Button
								disabled={!playerAId || !playerBId || submitting}
								onClick={handleSubmit}
							>
								{submitting ? 'Saving…' : 'Record Result'}
							</Button>
						</div>
					}
				>
					<div className="flex flex-col gap-5">
						<div className="flex flex-col gap-1.5">
							<label
								htmlFor={playerASelectId}
								className="text-sm font-medium text-gray-700 dark:text-gray-200"
							>
								Player A
							</label>
							{canRecordForOthers ? (
								<select
									id={playerASelectId}
									value={playerAId}
									onChange={(e) => {
										setPlayerAId(e.target.value);
										if (e.target.value === playerBId) setPlayerBId('');
									}}
									className="bg-slate-700 text-white border border-slate-500 rounded-lg px-3 py-2 w-full"
								>
									<option value="">Select a player…</option>
									{players.map((p) => (
										<option key={p.id} value={p.id}>
											{p.username}
										</option>
									))}
								</select>
							) : (
								<p
									id={playerASelectId}
									className="bg-slate-700/60 text-white border border-slate-600 rounded-lg px-3 py-2 w-full"
								>
									{players.find((p) => p.id === currentUser?.id)?.username ??
										'You'}
								</p>
							)}
						</div>

						<div className="flex flex-col gap-1.5">
							<label
								htmlFor={playerBSelectId}
								className="text-sm font-medium text-gray-700 dark:text-gray-200"
							>
								Player B
							</label>
							<select
								id={playerBSelectId}
								value={playerBId}
								onChange={(e) => setPlayerBId(e.target.value)}
								className="bg-slate-700 text-white border border-slate-500 rounded-lg px-3 py-2 w-full"
							>
								<option value="">Select a player…</option>
								{players
									.filter((p) => p.id !== playerAId)
									.map((p) => (
										<option key={p.id} value={p.id}>
											{p.username}
										</option>
									))}
							</select>
						</div>

						<RadioGroup
							label="Result"
							name="result"
							value={result}
							onChange={(v) => setResult(v as EloResult)}
							options={[
								{ value: 'A', label: `${playerAUsername ?? 'Player A'} won` },
								{ value: 'draw', label: 'Draw' },
								{ value: 'B', label: `${playerBUsername ?? 'Player B'} won` },
							]}
						/>

						{error && <p className="text-red-400 text-sm">{error}</p>}
					</div>
				</Dialog>
			</div>
		</div>
	);
}

function LeagueTable() {
	const { dbUser } = Route.useRouteContext();
	const router = useRouter();
	const [modalOpen, setModalOpen] = useState(false);
	const [page, setPage] = useState(1);
	const [search, setSearch] = useState('');
	const searchInputId = useId();

	const tableQuery = useQuery({
		queryKey: ['leaderboard', page, search],
		queryFn: () => getLeaguePlacesFn({ data: { page, search } }),
		placeholderData: (previous) => previous,
	});

	const myRankQuery = useQuery({
		queryKey: ['myRank', dbUser?.id],
		queryFn: () => getMyRankFn(),
		enabled: Boolean(dbUser),
	});

	const table = tableQuery.data;
	const rows = table?.data ?? [];
	// The modal's player picker needs the whole league, not the page in
	// view — a page-2 player must still be selectable from page 1.
	const lastPage = table
		? Math.max(1, Math.ceil(table.total / table.pageSize))
		: 1;
	const myPage =
		myRankQuery.data && table
			? pageForRank(myRankQuery.data, table.pageSize)
			: null;

	return (
		<div className="min-h-screen bg-gradient-to-b from-slate-900 via-slate-800 to-slate-900">
			<section className="relative py-20 px-6 text-center overflow-hidden">
				<div className="absolute inset-0 bg-gradient-to-r from-cyan-500/10 via-blue-500/10 to-purple-500/10"></div>
				<div className="relative max-w-5xl mx-auto">
					<div className="flex items-center justify-center gap-6 mb-6">
						<img
							src="/tanstack-circle-logo.png"
							alt="TanStack Logo"
							className="w-24 h-24 md:w-32 md:h-32"
						/>
						<h1 className="text-6xl md:text-7xl font-black text-white [letter-spacing:-0.08em]">
							<span className="text-gray-300">RANKING</span>
							<span className="bg-gradient-to-r from-cyan-400 to-blue-400 bg-clip-text text-transparent">
								S
							</span>
						</h1>
					</div>
				</div>
			</section>

			<section className="py-16 px-6 max-w-7xl mx-auto flex flex-col items-center">
				<SignInGate>
					<button
						type="button"
						onClick={() => setModalOpen(true)}
						className="mb-8 flex items-center gap-2 bg-gradient-to-r from-cyan-500 to-blue-500 hover:from-cyan-400 hover:to-blue-400 text-white font-semibold px-5 py-2.5 rounded-lg transition-all shadow-lg"
					>
						<PlusCircle className="w-5 h-5" />
						Record Game
					</button>

					<div className="w-full max-w-2xl mb-6 flex flex-wrap items-center gap-3">
						<label htmlFor={searchInputId} className="sr-only">
							Search players by name
						</label>
						<input
							id={searchInputId}
							value={search}
							onChange={(e) => {
								setSearch(e.target.value);
								// A new search invalidates the current page number.
								setPage(1);
							}}
							placeholder="Search players…"
							className="flex-1 min-w-48 bg-slate-700 border border-slate-500 text-white placeholder:text-slate-400 rounded-lg px-3 py-2"
						/>
						{myPage !== null && myRankQuery.data !== null && (
							<Button
								variant="secondary"
								size="small"
								onClick={() => {
									setSearch('');
									setPage(myPage);
								}}
							>
								Jump to my rank (#{myRankQuery.data})
							</Button>
						)}
					</div>

					<table>
						<thead>
							<tr className="border border-white bg-teal-600">
								<th className="text-white px-4 py-2">Rank</th>
								<th className="text-white px-4 py-2">Player</th>
								<th className="text-white px-4 py-2">Wins</th>
								<th className="text-white px-4 py-2">Losses</th>
								<th className="text-white px-4 py-2">Draws</th>
								<th className="text-white px-4 py-2">Games Played</th>
								<th className="text-white px-4 py-2">Rating</th>
							</tr>
						</thead>
						<tbody>
							{rows.map((player) => (
								<tr
									className={`border-y border-white text-center ${
										player.id === dbUser?.id
											? 'bg-cyan-500/20 text-white font-semibold'
											: 'text-white'
									}`}
									key={player.username}
								>
									<td className="py-1">{player.rank}</td>
									<td className="py-1">
										<Link
											to="/player/$username"
											params={{ username: player.username }}
											className="hover:text-cyan-300 hover:underline"
										>
											{player.username}
										</Link>
									</td>
									<td className="py-1">{player.wins}</td>
									<td className="py-1">{player.losses}</td>
									<td className="py-1">{player.draws}</td>
									<td className="py-1">{player.gamesPlayed}</td>
									<td className="py-1">{player.currentRating}</td>
								</tr>
							))}
						</tbody>
					</table>

					{tableQuery.isPending && (
						<p className="text-slate-400 mt-6">Loading rankings…</p>
					)}

					{tableQuery.isSuccess && rows.length === 0 && (
						<p className="text-slate-400 mt-6">
							{search ? `No players matching “${search}”.` : 'No players yet.'}
						</p>
					)}

					{table && table.total > table.pageSize && (
						<div className="flex items-center gap-4 mt-8">
							<Button
								variant="secondary"
								size="small"
								disabled={page <= 1}
								onClick={() => setPage((p) => Math.max(1, p - 1))}
							>
								Previous
							</Button>
							<span className="text-slate-300 text-sm">
								Page {table.page} of {lastPage}
							</span>
							<Button
								variant="secondary"
								size="small"
								disabled={page >= lastPage}
								onClick={() => setPage((p) => p + 1)}
							>
								Next
							</Button>
						</div>
					)}
				</SignInGate>
			</section>

			{modalOpen && (
				<RecordGameModal
					players={rows}
					currentUser={dbUser}
					onClose={() => setModalOpen(false)}
					onSuccess={() => {
						setModalOpen(false);
						router.invalidate();
					}}
				/>
			)}
		</div>
	);
}
