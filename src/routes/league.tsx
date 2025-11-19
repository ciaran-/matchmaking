import { createFileRoute } from '@tanstack/react-router';
import { getLeaguePlaces } from '@/data/league-places';

export const Route = createFileRoute('/league')({
	ssr: 'data-only',
	component: LeagueTable,
	loader: async () => await getLeaguePlaces(),
});

function LeagueTable() {
	const leaguePlaces = Route.useLoaderData();
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
				<table>
					<thead>
						<tr className="border border-white bg-teal-600">
							<th className="text-white px-4 py-2">Rank</th>
							<th className="text-white px-4 py-2">Player</th>
							<th className="text-white px-4 py-2">Record</th>
							<th className="text-white px-4 py-2">Rating</th>
						</tr>
					</thead>
					<tbody>
						{leaguePlaces.map((place) => (
							<tr
								className="border-y border-white text-white text-center"
								key={place.user}
							>
								<td className="py-1">{place.id}</td>
								<td className="py-1">{place.user}</td>
								<td className="py-1">
									{place.record[0]}-{place.record[1]}
								</td>
								<td className="py-1">{place.rating}</td>
							</tr>
						))}
					</tbody>
				</table>
			</section>
		</div>
	);
}
