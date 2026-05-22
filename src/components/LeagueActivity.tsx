import type {
	LeagueActivityBucket,
	LeagueActivityBundle,
} from '@/lib/matchmaking/dashboard';

interface Props {
	bundle: LeagueActivityBundle | undefined;
	isLoading: boolean;
	error?: { message?: string };
}

const LANES = ['searching', 'awaitingConfirmation', 'playing'] as const;
type Lane = (typeof LANES)[number];

const LANE_LABELS: Record<Lane, string> = {
	searching: 'Searching',
	awaitingConfirmation: 'Awaiting confirmation',
	playing: 'Playing',
};

const LANE_COLORS: Record<Lane, string> = {
	searching: '#22d3ee', // cyan-400
	awaitingConfirmation: '#fbbf24', // amber-400
	playing: '#34d399', // emerald-400
};

const VIEW_W = 600;
const VIEW_H = 200;
const CHART_LEFT = 50;
const CHART_RIGHT = 580;
const LANE_Y: Record<Lane, number> = {
	searching: 40,
	awaitingConfirmation: 100,
	playing: 160,
};
const STALE_MS = 30_000;
const BUCKET_SIZE = 25;

function pickTickInterval(span: number): number {
	if (span <= 200) return 50;
	if (span <= 500) return 100;
	if (span <= 1000) return 200;
	return 500;
}

export function LeagueActivity({ bundle, isLoading, error }: Props) {
	if (error && !bundle) {
		return (
			<Frame>
				<p className="mt-3 text-sm text-slate-400">
					Couldn&apos;t load league activity.
				</p>
			</Frame>
		);
	}

	if (!bundle) {
		return (
			<Frame>
				<p className="mt-3 text-sm text-slate-400">
					{isLoading ? 'Loading…' : ''}
				</p>
			</Frame>
		);
	}

	const { buckets, recentResults, generatedAt } = bundle;
	const isStale = Date.now() - new Date(generatedAt).getTime() > STALE_MS;
	const isEmpty =
		buckets.length === 0 &&
		recentResults.last5Min === 0 &&
		recentResults.lastHour === 0 &&
		recentResults.last24h === 0;

	return (
		<Frame stale={isStale}>
			<div className="mt-4 grid grid-cols-3 gap-2">
				<Counter label="Last 5 min" value={recentResults.last5Min} />
				<Counter label="Last hour" value={recentResults.lastHour} />
				<Counter label="Last 24h" value={recentResults.last24h} />
			</div>

			{isEmpty ? (
				<p className="mt-6 text-sm text-slate-400">No activity right now.</p>
			) : (
				<Chart buckets={buckets} />
			)}
		</Frame>
	);
}

function Frame({
	children,
	stale,
}: {
	children: React.ReactNode;
	stale?: boolean;
}) {
	return (
		<section className="rounded-xl border border-slate-700 bg-slate-800/60 px-6 py-5">
			<div className="flex items-center justify-between">
				<h2 className="text-xs uppercase tracking-widest text-slate-400">
					League activity
				</h2>
				{stale && (
					<span className="text-xs uppercase tracking-widest text-slate-500">
						stale
					</span>
				)}
			</div>
			{children}
		</section>
	);
}

function Counter({ label, value }: { label: string; value: number }) {
	return (
		<div className="rounded-lg border border-slate-700 bg-slate-900/40 px-3 py-2 text-center">
			<p className="text-[10px] uppercase tracking-wider text-slate-500">
				{label}
			</p>
			<p className="mt-1 text-lg font-semibold text-slate-100">{value}</p>
		</div>
	);
}

function Chart({ buckets }: { buckets: LeagueActivityBucket[] }) {
	const ratings = buckets.map((b) => b.rating);
	const minBucket = Math.min(...ratings);
	const maxBucket = Math.max(...ratings);
	// Pad the visible range by ~50 either side, snapped to bucket boundaries.
	const min = Math.floor((minBucket - 50) / BUCKET_SIZE) * BUCKET_SIZE;
	const max = Math.ceil((maxBucket + 75) / BUCKET_SIZE) * BUCKET_SIZE;
	const span = max - min || 1;

	const xFor = (r: number) =>
		CHART_LEFT + ((r - min) / span) * (CHART_RIGHT - CHART_LEFT);

	const tickInterval = pickTickInterval(span);
	const tickStart = Math.ceil(min / tickInterval) * tickInterval;
	const tickCount = Math.floor((max - tickStart) / tickInterval) + 1;
	const ticks = Array.from(
		{ length: tickCount },
		(_, i) => tickStart + i * tickInterval,
	);

	return (
		<div className="mt-6">
			<svg
				viewBox={`0 0 ${VIEW_W} ${VIEW_H}`}
				className="w-full h-48"
				role="img"
				aria-label="League activity by rating bucket"
			>
				{LANES.map((lane) => (
					<line
						key={lane}
						x1={CHART_LEFT}
						x2={CHART_RIGHT}
						y1={LANE_Y[lane]}
						y2={LANE_Y[lane]}
						stroke="#334155"
						strokeWidth={0.5}
					/>
				))}

				{buckets.flatMap((b) => {
					const cx = xFor(b.rating + BUCKET_SIZE / 2);
					return LANES.filter((lane) => b[lane] > 0).map((lane) => {
						const count = b[lane];
						const r = Math.sqrt(count) * 4;
						const upper = b.rating + BUCKET_SIZE - 1;
						const label = LANE_LABELS[lane].toLowerCase();
						return (
							<circle
								key={`${b.rating}-${lane}`}
								cx={cx}
								cy={LANE_Y[lane]}
								r={r}
								fill={LANE_COLORS[lane]}
								opacity={0.85}
							>
								<title>{`Rating ${b.rating}–${upper}: ${count} ${label}`}</title>
							</circle>
						);
					});
				})}

				{ticks.map((t) => (
					<text
						key={t}
						x={xFor(t)}
						y={VIEW_H - 5}
						textAnchor="middle"
						fontSize={10}
						fill="#64748b"
					>
						{t}
					</text>
				))}
			</svg>

			<div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-slate-400">
				{LANES.map((lane) => (
					<span key={lane} className="flex items-center gap-1.5">
						<span
							className="inline-block w-2.5 h-2.5 rounded-full"
							style={{ backgroundColor: LANE_COLORS[lane] }}
						/>
						{LANE_LABELS[lane]}
					</span>
				))}
			</div>
		</div>
	);
}
