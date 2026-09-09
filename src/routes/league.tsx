import { createFileRoute, useRouter } from '@tanstack/react-router';
import { createServerFn } from '@tanstack/react-start';
import { PlusCircle } from 'lucide-react';
import { useId, useState } from 'react';
import { SignInGate } from '@/components/SignInGate';
import { Button } from '@/components/storybook/button';
import { Dialog } from '@/components/storybook/dialog';
import { RadioGroup } from '@/components/storybook/radio-group';
import { prisma } from '@/db';
import { authenticatedUser } from '@/lib/auth';
import { canActOnGame } from '@/lib/authorization';
import type { EloResult } from '@/lib/elo';
import { recordGame } from '@/lib/record-game';
import { userFacingError } from '@/lib/user-facing-errors';

const getLeaguePlaces = createServerFn({
	method: 'GET',
}).handler(async () => {
	return await (prisma
		? prisma.user.findMany({
				orderBy: { currentRating: 'desc' },
				include: { gameParticipations: true },
			})
		: []);
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
	loader: async () => await getLeaguePlaces(),
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
	const leaguePlaces = Route.useLoaderData();
	const { dbUser } = Route.useRouteContext();
	const router = useRouter();
	const [modalOpen, setModalOpen] = useState(false);

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
					<table>
						<thead>
							<tr className="border border-white bg-teal-600">
								<th className="text-white px-4 py-2">Rank</th>
								<th className="text-white px-4 py-2">Player</th>
								<th className="text-white px-4 py-2">Wins</th>
								<th className="text-white px-4 py-2">Losses</th>
								<th className="text-white px-4 py-2">Games Played</th>
								<th className="text-white px-4 py-2">Rating</th>
							</tr>
						</thead>
						<tbody>
							{leaguePlaces.length > 0 &&
								leaguePlaces.map((player, index) => (
									<tr
										className="border-y border-white text-white text-center"
										key={player.username}
									>
										<td className="py-1">{index + 1}</td>
										<td className="py-1">{player.username}</td>
										<td className="py-1">
											{
												player.gameParticipations.filter(
													(game) => game.ratingChange > 0,
												).length
											}
										</td>
										<td className="py-1">
											{
												player.gameParticipations.filter(
													(game) => game.ratingChange < 0,
												).length
											}
										</td>
										<td className="py-1">{player.gameParticipations.length}</td>
										<td className="py-1">{player.currentRating}</td>
									</tr>
								))}
						</tbody>
					</table>
				</SignInGate>
			</section>

			{modalOpen && (
				<RecordGameModal
					players={leaguePlaces}
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
