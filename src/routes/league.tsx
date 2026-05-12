import { useUser } from '@clerk/clerk-react';
import { createFileRoute, useRouter } from '@tanstack/react-router';
import { createServerFn } from '@tanstack/react-start';
import { PlusCircle } from 'lucide-react';
import { useId, useState } from 'react';
import { Button } from '@/components/storybook/button';
import { Dialog } from '@/components/storybook/dialog';
import { RadioGroup } from '@/components/storybook/radio-group';
import { prisma } from '@/db';
import type { EloResult } from '@/lib/elo';

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
		const secretKey = process.env.CLERK_SECRET_KEY;
		const publishableKey = process.env.VITE_CLERK_PUBLISHABLE_KEY;
		if (!secretKey || !publishableKey)
			throw new Error('Missing Clerk env vars');

		const { createClerkClient } = await import('@clerk/backend');
		const { getRequest } = await import('@tanstack/react-start/server');
		const clerk = createClerkClient({ secretKey, publishableKey });
		const auth = await clerk.authenticateRequest(getRequest());
		if (!auth.isSignedIn) throw new Error('Unauthorized');

		const { recordGame } = await import('../lib/record-game');
		return recordGame(data);
	});

export const Route = createFileRoute('/league')({
	ssr: 'data-only',
	component: LeagueTable,
	loader: async () => await getLeaguePlaces(),
});

function LeagueTable() {
	const { isSignedIn, isLoaded } = useUser();
	const leaguePlaces = Route.useLoaderData();
	const router = useRouter();
	const playerASelectId = useId();
	const playerBSelectId = useId();
	const [modalOpen, setModalOpen] = useState(false);
	const [playerAId, setPlayerAId] = useState('');
	const [playerBId, setPlayerBId] = useState('');
	const [result, setResult] = useState<EloResult>('A');
	const [submitting, setSubmitting] = useState(false);
	const [error, setError] = useState<string | null>(null);

	const playerAUsername = leaguePlaces.find(
		(p) => p.id === playerAId,
	)?.username;
	const playerBUsername = leaguePlaces.find(
		(p) => p.id === playerBId,
	)?.username;

	async function handleSubmit() {
		if (!playerAId || !playerBId) return;
		setSubmitting(true);
		setError(null);
		try {
			await recordGameFn({ data: { playerAId, playerBId, result } });
			setModalOpen(false);
			setPlayerAId('');
			setPlayerBId('');
			setResult('A');
			router.invalidate();
		} catch (e) {
			setError((e as { message?: string }).message ?? 'Failed to record game');
		} finally {
			setSubmitting(false);
		}
	}

	if (!isLoaded) {
		return <div className="p-4">Loading...</div>;
	}

	if (!isSignedIn) {
		return <div className="p-4">Sign in to view this page</div>;
	}
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
			</section>

			{modalOpen && (
				<div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm">
					<div
						role="dialog"
						aria-modal="true"
						aria-label="Record Game Result"
						className="w-full max-w-md mx-4"
						onKeyDown={(e) => e.key === 'Escape' && setModalOpen(false)}
					>
						<Dialog
							title="Record Game Result"
							footer={
								<div className="flex justify-end gap-3">
									<Button
										variant="secondary"
										onClick={() => setModalOpen(false)}
									>
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
									<select
										id={playerASelectId}
										value={playerAId}
										onChange={(e) => setPlayerAId(e.target.value)}
										className="bg-slate-700 text-white border border-slate-500 rounded-lg px-3 py-2 w-full"
									>
										<option value="">Select a player…</option>
										{leaguePlaces.map((p) => (
											<option key={p.id} value={p.id}>
												{p.username}
											</option>
										))}
									</select>
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
										{leaguePlaces
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
										{
											value: 'A',
											label: `${playerAUsername ?? 'Player A'} won`,
										},
										{ value: 'draw', label: 'Draw' },
										{
											value: 'B',
											label: `${playerBUsername ?? 'Player B'} won`,
										},
									]}
								/>

								{error && <p className="text-red-400 text-sm">{error}</p>}
							</div>
						</Dialog>
					</div>
				</div>
			)}
		</div>
	);
}
