import { SignInButton, useUser } from '@clerk/react';
import { createFileRoute, Link } from '@tanstack/react-router';

export const Route = createFileRoute('/')({ component: Home });

function Home() {
	const { isLoaded, isSignedIn } = useUser();

	return (
		<div className="min-h-screen bg-gradient-to-b from-slate-900 via-slate-800 to-slate-900 text-white">
			<section className="relative py-20 px-6 text-center overflow-hidden">
				<div className="absolute inset-0 bg-gradient-to-r from-cyan-500/10 via-blue-500/10 to-purple-500/10"></div>
				<div className="relative max-w-3xl mx-auto">
					<div className="flex items-center justify-center gap-6 mb-6">
						<img
							src="/tanstack-circle-logo.png"
							alt="Matchmaking logo"
							className="w-24 h-24 md:w-32 md:h-32"
						/>
						<h1 className="text-6xl md:text-7xl font-black text-white [letter-spacing:-0.08em]">
							<span className="text-gray-300">MATCH</span>
							<span className="bg-gradient-to-r from-cyan-400 to-blue-400 bg-clip-text text-transparent">
								MAKING
							</span>
						</h1>
					</div>
					<p className="text-lg md:text-xl text-gray-300 mb-10 font-light">
						Internal 1v1 matchmaking with Elo ratings.
					</p>

					{!isLoaded && <p className="text-gray-400">Loading…</p>}

					{isLoaded && !isSignedIn && (
						<SignInButton mode="modal">
							<button
								type="button"
								className="inline-block px-6 py-3 rounded-lg font-semibold text-white bg-gradient-to-r from-cyan-500 to-blue-500 hover:from-cyan-400 hover:to-blue-400 shadow-lg shadow-cyan-500/30 transition-colors"
							>
								Sign in to find a match →
							</button>
						</SignInButton>
					)}

					{isLoaded && isSignedIn && (
						<div className="flex flex-col sm:flex-row items-center justify-center gap-4">
							<Link
								to="/match"
								className="inline-block px-6 py-3 rounded-lg font-semibold text-white bg-gradient-to-r from-cyan-500 to-blue-500 hover:from-cyan-400 hover:to-blue-400 shadow-lg shadow-cyan-500/30 transition-colors"
							>
								Find a match
							</Link>
							<Link
								to="/league"
								className="inline-block px-6 py-3 rounded-lg font-semibold text-white bg-gradient-to-r from-cyan-500 to-blue-500 hover:from-cyan-400 hover:to-blue-400 shadow-lg shadow-cyan-500/30 transition-colors"
							>
								League table
							</Link>
						</div>
					)}
				</div>
			</section>
		</div>
	);
}
