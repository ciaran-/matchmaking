import { createFileRoute } from '@tanstack/react-router';
import { toErrorResponse } from '@/lib/api/errors';
import { apiMiddleware } from '@/lib/api/middleware';
import { jsonOk } from '@/lib/api/respond';
import { resolveApiUser } from '@/lib/auth';
import { getLeagueActivity } from '@/lib/matchmaking/dashboard';

/**
 * `GET /api/v1/league/activity` — the anonymised league-wide activity
 * bundle behind the dashboard panel (rating-bucketed counts of
 * searching / awaiting-confirmation / playing, plus rolling
 * recently-played counts).
 *
 * Gated on a signed-in caller (either credential), mirroring
 * `getLeagueActivityFn` in `src/routes/match.tsx` — the bundle itself
 * carries no identifying fields (see the anonymisation contract in
 * `dashboard.integration.test.ts`), but it still isn't exposed
 * anonymously. Returned **unchanged** from `getLeagueActivity` — no
 * reshaping in this adapter.
 */
export const Route = createFileRoute('/api/v1/league/activity')({
	server: {
		middleware: [apiMiddleware],
		handlers: {
			GET: async ({ request }) => {
				try {
					await resolveApiUser(request);
					return jsonOk(await getLeagueActivity());
				} catch (e) {
					return toErrorResponse(e, "Couldn't load league activity.");
				}
			},
		},
	},
});
