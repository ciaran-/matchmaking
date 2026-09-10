/**
 * Pure pagination arithmetic, shared by server reads and client controls.
 *
 * Deliberately **not** in `leaderboard.ts`. That module is server-only —
 * it imports `@/db` and `Prisma` — so a client component importing one
 * pure helper from it drags the Prisma client into the browser bundle.
 * That is not hypothetical: it happened, and the client-bundle grep in
 * CLAUDE.md caught `PrismaClient` in the league chunk.
 *
 * Anything here must stay free of server-only imports.
 */

export const DEFAULT_PAGE_SIZE = 25;

/** The 1-based page a given rank falls on. */
export function pageForRank(
	rank: number,
	pageSize: number = DEFAULT_PAGE_SIZE,
): number {
	return Math.max(1, Math.ceil(rank / pageSize));
}

/** Total pages for a result set, never fewer than one. */
export function pageCount(
	total: number,
	pageSize: number = DEFAULT_PAGE_SIZE,
): number {
	return Math.max(1, Math.ceil(total / pageSize));
}
