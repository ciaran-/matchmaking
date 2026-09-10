import { useQuery } from '@tanstack/react-query';
import { createFileRoute, Link } from '@tanstack/react-router';
import { createServerFn } from '@tanstack/react-start';
import { SignInGate } from '@/components/SignInGate';
import { authenticatedUser } from '@/lib/auth';
import { getPlayerProfile, type PlayerProfile } from '@/lib/player-profile';
import { userFacingError } from '@/lib/user-facing-errors';

/**
 * POST, not GET: the handler performs a Clerk auth check, so it must not
 * be reachable by router preloading (see CLAUDE.md).
 */
const getPlayerProfileFn = createServerFn({ method: 'POST' })
	.inputValidator((data: { username: string }) => data)
	.handler(async ({ data }) => {
		await authenticatedUser();
		return getPlayerProfile(data.username);
	});

export const Route = createFileRoute('/player/$username')({
	ssr: 'data-only',
	component: PlayerProfilePage,
});

function PlayerProfilePage() {
	const { username } = Route.useParams();

	return (
		<div className="min-h-screen bg-gradient-to-b from-slate-900 via-slate-800 to-slate-900">
			<section className="py-16 px-6 max-w-4xl mx-auto">
				{/*
				 * Fetched inside the gate, not in a route loader. The read
				 * requires auth, and a loader runs before the gate can render —
				 * so a signed-out visitor got a 500 instead of a sign-in form.
				 * Same reason `/match` and `/settings/api-keys` fetch this way.
				 */}
				<SignInGate>
					<ProfileLoader username={username} />
				</SignInGate>
			</section>
		</div>
	);
}

function ProfileLoader({ username }: { username: string }) {
	const profileQuery = useQuery({
		queryKey: ['playerProfile', username],
		queryFn: () => getPlayerProfileFn({ data: { username } }),
	});

	if (profileQuery.isPending) {
		return <p className="text-slate-400">Loading profile…</p>;
	}

	if (profileQuery.isError) {
		return (
			<p className="text-red-300">
				{userFacingError(profileQuery.error, "Couldn't load that profile.")}
			</p>
		);
	}

	return profileQuery.data ? (
		<PlayerDetail profile={profileQuery.data} />
	) : (
		<NotFound username={username} />
	);
}

function NotFound({ username }: { username: string }) {
	return (
		<div className="text-center py-16">
			<h1 className="text-3xl font-bold text-white mb-3">No such player</h1>
			<p className="text-slate-400 mb-8">
				Nobody here goes by <span className="text-slate-200">{username}</span>.
			</p>
			<Link
				to="/league"
				className="text-cyan-400 hover:text-cyan-300 hover:underline"
			>
				Back to the rankings
			</Link>
		</div>
	);
}

function Stat({ label, value }: { label: string; value: string | number }) {
	return (
		<div className="rounded-xl border border-slate-700 bg-slate-800/60 px-5 py-4 text-center">
			<p className="text-3xl font-black text-white">{value}</p>
			<p className="text-slate-400 text-sm mt-1">{label}</p>
		</div>
	);
}

function PlayerDetail({ profile }: { profile: PlayerProfile }) {
	const memberSince = new Date(profile.memberSince).toLocaleDateString(
		undefined,
		{ year: 'numeric', month: 'long' },
	);

	return (
		<div className="flex flex-col gap-10">
			<header>
				<h1 className="text-5xl font-black text-white [letter-spacing:-0.04em]">
					{profile.username}
				</h1>
				<p className="text-slate-400 mt-2">Playing since {memberSince}</p>
			</header>

			<div className="grid grid-cols-2 md:grid-cols-4 gap-4">
				<Stat label="Rating" value={profile.currentRating} />
				<Stat label="Rank" value={`#${profile.rank}`} />
				<Stat label="Games" value={profile.gamesPlayed} />
				<Stat
					label="Record"
					value={`${profile.wins}–${profile.losses}–${profile.draws}`}
				/>
			</div>

			{profile.gamesPlayed === 0 && (
				<p className="text-slate-400">
					No games played yet — the record fills in after the first result is
					recorded.
				</p>
			)}

			<Link
				to="/league"
				className="text-cyan-400 hover:text-cyan-300 hover:underline"
			>
				Back to the rankings
			</Link>
		</div>
	);
}
