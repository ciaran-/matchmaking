import { createFileRoute } from '@tanstack/react-router';
import { z } from 'zod';
import { toErrorResponse } from '@/lib/api/errors';
import { apiMiddleware } from '@/lib/api/middleware';
import { jsonError, jsonOk } from '@/lib/api/respond';
import { resolveApiUser } from '@/lib/auth';
import { getLeaderboard } from '@/lib/leaderboard';

/** Query params. Absent values fall back to the lib's defaults. */
const querySchema = z.object({
	page: z.coerce.number().int().positive().optional(),
	pageSize: z.coerce.number().int().positive().max(100).optional(),
	search: z.string().optional(),
});

/**
 * `GET /api/v1/leaderboard` — the league table.
 *
 * The reference implementation of the conventions in
 * `docs/api-conventions.md`: authenticate with either
 * credential, delegate to the `src/lib/` core, serialise through
 * `respond.ts`, and map any throw onto the standard error envelope.
 * Later endpoints copy this shape.
 *
 * Paginated with page/offset rather than a cursor, unlike match history.
 * A ranked table is navigated by position — "page 7", "jump to my rank" —
 * which a cursor cannot express, and the page controls need `total`. See
 * conventions §3.
 */
export const Route = createFileRoute('/api/v1/leaderboard')({
	server: {
		middleware: [apiMiddleware],
		handlers: {
			GET: async ({ request }) => {
				try {
					await resolveApiUser(request);

					// Query params, not a body — `safeParse` directly, since
					// reading them cannot throw the way `request.json()` can.
					const params = querySchema.safeParse(
						Object.fromEntries(new URL(request.url).searchParams),
					);
					if (!params.success) {
						return jsonError('bad_request', 'Invalid query parameters.', 400);
					}

					return jsonOk(await getLeaderboard(params.data));
				} catch (e) {
					return toErrorResponse(e, "Couldn't load the leaderboard.");
				}
			},
		},
	},
});
