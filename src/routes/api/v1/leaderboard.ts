import { createFileRoute } from '@tanstack/react-router';
import { toErrorResponse } from '@/lib/api/errors';
import { jsonOk } from '@/lib/api/respond';
import { resolveApiUser } from '@/lib/auth';
import { getLeaderboard } from '@/lib/leaderboard';

/**
 * `GET /api/v1/leaderboard` — the league table.
 *
 * The reference implementation of the conventions in
 * `.claude/plans/feature-6-api-conventions.md`: authenticate with either
 * credential, delegate to the `src/lib/` core, serialise through
 * `respond.ts`, and map any throw onto the standard error envelope.
 * Later endpoints copy this shape.
 */
export const Route = createFileRoute('/api/v1/leaderboard')({
	server: {
		handlers: {
			GET: async ({ request }) => {
				try {
					await resolveApiUser(request);
					return jsonOk(await getLeaderboard());
				} catch (e) {
					return toErrorResponse(e, "Couldn't load the leaderboard.");
				}
			},
		},
	},
});
