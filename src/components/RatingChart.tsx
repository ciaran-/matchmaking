import { DEFAULT_RATING } from '@/lib/game-series';
import type { RatingHistoryPoint } from '@/lib/player-rating-history';

interface Props {
	/**
	 * The player's real game snapshots, oldest first (from
	 * `getPlayerRatingHistory` / `GET /api/v1/players/:username/ratings`).
	 * `undefined` while loading or on error — same convention as
	 * `LeagueActivity`'s `bundle` prop.
	 */
	history: RatingHistoryPoint[] | undefined;
	isLoading: boolean;
	error?: { message?: string };
}

/**
 * One rendered point. `at`/`gameResultId` are `null` only for the
 * synthetic starting-rating point this component prepends — real games
 * always carry both.
 */
interface ChartPoint {
	rating: number;
	at: string | null;
	gameResultId: string | null;
}

const VIEW_W = 600;
const VIEW_H = 200;
const CHART_LEFT = 50;
const CHART_RIGHT = 580;
const CHART_TOP = 15;
const CHART_BOTTOM = 165;
const LINE_COLOR = '#818cf8'; // indigo-400
const GRID_COLOR = '#334155';
const TICK_COLOR = '#64748b';
// A floor on the visible rating span, so a flat or near-flat series
// doesn't get zoomed in until a two- or three-point swing reads as a
// dramatic climb. Elo movements per game are typically single digits to
// low tens, so 100 keeps genuinely small swings looking small.
const MIN_RATING_SPAN = 100;
const RATING_GRID = 25;

function pickTickInterval(span: number): number {
	if (span <= 100) return 25;
	if (span <= 250) return 50;
	if (span <= 600) return 100;
	if (span <= 1200) return 250;
	return 500;
}

function pickIndexLabelStep(gamesPlayed: number): number {
	if (gamesPlayed <= 10) return 1;
	if (gamesPlayed <= 20) return 2;
	if (gamesPlayed <= 50) return 5;
	if (gamesPlayed <= 100) return 10;
	return Math.ceil(gamesPlayed / 10);
}

/**
 * A player's rating over time as an inline-SVG line chart, hand-rolled to
 * match `LeagueActivity` — no charting library, per CLAUDE.md and the
 * feature plan.
 *
 * X-axis is game index (even spacing), not real time — see
 * `getPlayerRatingHistory` for why every point still keeps its
 * timestamp. Self-contained: pass the raw history array (possibly
 * empty) and this component handles the `DEFAULT_RATING` origin point,
 * the 0-game single-point case, and the 1-game two-point case.
 */
export function RatingChart({ history, isLoading, error }: Props) {
	if (error && !history) {
		return (
			<Frame>
				<p className="mt-3 text-sm text-slate-400">
					Couldn&apos;t load rating history.
				</p>
			</Frame>
		);
	}

	if (!history) {
		return (
			<Frame>
				<p className="mt-3 text-sm text-slate-400">
					{isLoading ? 'Loading…' : ''}
				</p>
			</Frame>
		);
	}

	// The origin point is a presentation concern, not recorded history —
	// see getPlayerRatingHistory's docstring. Prepending it here means a
	// player with zero games still renders one point instead of an empty
	// chart, and one game renders a real two-point line.
	const points: ChartPoint[] = [
		{ rating: DEFAULT_RATING, at: null, gameResultId: null },
		...history,
	];

	return (
		<Frame>
			<Chart points={points} />
		</Frame>
	);
}

function Frame({ children }: { children: React.ReactNode }) {
	return (
		<section className="rounded-xl border border-slate-700 bg-slate-800/60 px-6 py-5">
			<h2 className="text-xs uppercase tracking-widest text-slate-400">
				Rating progression
			</h2>
			{children}
		</section>
	);
}

function Chart({ points }: { points: ChartPoint[] }) {
	const ratings = points.map((p) => p.rating);
	const minRating = Math.min(...ratings);
	const maxRating = Math.max(...ratings);
	const rawSpan = maxRating - minRating;

	// Pad the visible range, snapped to grid boundaries, then enforce a
	// floor on the span so the y-axis never silently exaggerates a small
	// swing (see MIN_RATING_SPAN above).
	const pad = Math.max(RATING_GRID, Math.ceil(rawSpan * 0.2));
	let min = Math.floor((minRating - pad) / RATING_GRID) * RATING_GRID;
	let max = Math.ceil((maxRating + pad) / RATING_GRID) * RATING_GRID;
	if (max - min < MIN_RATING_SPAN) {
		const mid = (max + min) / 2;
		min = Math.floor((mid - MIN_RATING_SPAN / 2) / RATING_GRID) * RATING_GRID;
		max = Math.ceil((mid + MIN_RATING_SPAN / 2) / RATING_GRID) * RATING_GRID;
	}
	const span = max - min || 1;

	const xFor = (i: number) =>
		points.length === 1
			? (CHART_LEFT + CHART_RIGHT) / 2
			: CHART_LEFT + (i / (points.length - 1)) * (CHART_RIGHT - CHART_LEFT);
	const yFor = (rating: number) =>
		CHART_BOTTOM - ((rating - min) / span) * (CHART_BOTTOM - CHART_TOP);

	const linePoints = points
		.map((p, i) => `${xFor(i)},${yFor(p.rating)}`)
		.join(' ');

	const tickInterval = pickTickInterval(span);
	const tickStart = Math.ceil(min / tickInterval) * tickInterval;
	const tickCount = Math.floor((max - tickStart) / tickInterval) + 1;
	const yTicks = Array.from(
		{ length: tickCount },
		(_, i) => tickStart + i * tickInterval,
	);

	const gamesPlayed = points.length - 1;
	const labelStep = pickIndexLabelStep(gamesPlayed);
	const xLabels = points
		.map((_, i) => i)
		.filter((i) => i === 0 || i === points.length - 1 || i % labelStep === 0);

	const first = points[0];
	const last = points[points.length - 1];
	const delta = last.rating - first.rating;
	const trend =
		delta === 0
			? 'unchanged'
			: `${delta > 0 ? 'up' : 'down'} ${Math.abs(delta)}`;
	const summary =
		gamesPlayed === 0
			? `Rating progression: no games played yet. Starting rating ${first.rating}.`
			: `Rating progression over ${gamesPlayed} game${gamesPlayed === 1 ? '' : 's'}: ` +
				`from ${first.rating} to ${last.rating}, ${trend}.`;

	return (
		<div className="mt-4">
			<svg
				viewBox={`0 0 ${VIEW_W} ${VIEW_H}`}
				className="w-full h-48"
				role="img"
				aria-label={summary}
			>
				{yTicks.map((t) => (
					<g key={t}>
						<line
							x1={CHART_LEFT}
							x2={CHART_RIGHT}
							y1={yFor(t)}
							y2={yFor(t)}
							stroke={GRID_COLOR}
							strokeWidth={0.5}
						/>
						<text
							x={CHART_LEFT - 8}
							y={yFor(t)}
							textAnchor="end"
							dominantBaseline="middle"
							fontSize={10}
							fill={TICK_COLOR}
						>
							{t}
						</text>
					</g>
				))}

				{points.length > 1 && (
					<polyline
						points={linePoints}
						fill="none"
						stroke={LINE_COLOR}
						strokeWidth={2}
					/>
				)}

				{points.map((p, i) => (
					<circle
						key={p.gameResultId ?? 'start'}
						cx={xFor(i)}
						cy={yFor(p.rating)}
						r={3.5}
						fill={LINE_COLOR}
					>
						<title>
							{p.at
								? `Game ${i}: rating ${p.rating} (${new Date(p.at).toLocaleDateString()})`
								: `Starting rating: ${p.rating}`}
						</title>
					</circle>
				))}

				{xLabels.map((i) => (
					<text
						key={i}
						x={xFor(i)}
						y={VIEW_H - 5}
						textAnchor="middle"
						fontSize={10}
						fill={TICK_COLOR}
					>
						{i === 0 ? 'Start' : i}
					</text>
				))}
			</svg>
		</div>
	);
}
