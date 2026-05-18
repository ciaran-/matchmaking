/**
 * Map a thrown error from a server function into a user-facing string.
 *
 * Hybrid policy:
 *   - A small allowlist of known, *safe-to-surface* messages get their
 *     own friendly copy ("Please sign in.", "Match already ended.").
 *   - Anything else falls through to the caller's `fallback` — a short,
 *     action-specific string like "Couldn't start a match."
 *
 * The raw error message is never returned. This prevents Prisma /
 * stack-trace / implementation detail from leaking to end users while
 * Sentry still captures the original error for diagnosis.
 *
 * Grow the allowlist organically. A message belongs here when:
 *   - It maps to a user action they could plausibly take to resolve it.
 *   - The text we surface to the user is intentional copy, not the raw
 *     thrown message.
 */
export function userFacingError(e: unknown, fallback: string): string {
	const msg = (e as { message?: string }).message ?? '';

	if (msg === 'Unauthorized') return 'Please sign in to continue.';
	if (msg.includes('not a participant')) {
		return "You're not part of this match.";
	}
	if (msg.includes('already terminal')) {
		return 'This match has already ended.';
	}
	if (msg.includes('not BOTH_CONFIRMED') || msg.includes('first-wins')) {
		return 'Result already recorded by your opponent.';
	}

	return fallback;
}
