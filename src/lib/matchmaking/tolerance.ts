export const TOLERANCE_BASE = 50;
export const TOLERANCE_GROWTH_PER_SEC = 10;
export const TOLERANCE_CAP = 400;

/**
 * Returns the rating tolerance (one-sided, in Elo points) for a search that
 * has been waiting for `elapsedSeconds`. Starts at TOLERANCE_BASE, grows
 * linearly at TOLERANCE_GROWTH_PER_SEC per second, and caps at TOLERANCE_CAP.
 *
 * Negative `elapsedSeconds` is clamped to 0 — a freshly created search and a
 * (nominally impossible) "future" search both get the base tolerance.
 */
export function toleranceForElapsed(elapsedSeconds: number): number {
	const clamped = Math.max(0, elapsedSeconds);
	return Math.min(
		TOLERANCE_BASE + TOLERANCE_GROWTH_PER_SEC * clamped,
		TOLERANCE_CAP,
	);
}

/**
 * Returns the acceptable rating band for a player at `rating` who has been
 * waiting for `elapsedSeconds`. The band is symmetric around `rating`.
 */
export function ratingBand(
	rating: number,
	elapsedSeconds: number,
): { min: number; max: number } {
	const t = toleranceForElapsed(elapsedSeconds);
	return { min: rating - t, max: rating + t };
}
