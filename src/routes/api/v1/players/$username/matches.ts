import { createFileRoute } from '@tanstack/react-router';
import { z } from 'zod';
import { toErrorResponse } from '@/lib/api/errors';
import { apiMiddleware } from '@/lib/api/middleware';
import { jsonError, jsonOk } from '@/lib/api/respond';
import { resolveApiUser } from '@/lib/auth';
import { getPlayerMatchHistory } from '@/lib/player-match-history';

const querySchema = z.object({
	cursor: z.string().min(1).optional(),
	limit: z.coerce.number().int().min(1).max(50).optional(),
});

/**
 * `GET /api/v1/players/:username/matches` — a player's completed match
 * history, newest first: opponent, outcome, rating movement, when.
 *
 * Same authorization stance as `GET /api/v1/players/:username`: any
 * authenticated caller may read any player's history. Opponent identities
 * here are no more sensitive than the profile record they already appear
 * in — see that route's doc comment.
 *
 * Paginated, so this endpoint uses the `{ data, nextCursor }` envelope
 * per conventions §3, unlike the bare-object profile route.
 */
export const Route = createFileRoute('/api/v1/players/$username/matches')({
	server: {
		middleware: [apiMiddleware],
		handlers: {
			GET: async ({ request, params }) => {
				try {
					await resolveApiUser(request);

					const url = new URL(request.url);
					const parsedQuery = querySchema.safeParse(
						Object.fromEntries(url.searchParams),
					);
					if (!parsedQuery.success) {
						return jsonError('bad_request', 'Invalid query parameters.', 400);
					}

					const page = await getPlayerMatchHistory(
						params.username,
						parsedQuery.data,
					);
					if (!page) {
						throw new Error(`Player ${params.username} not found`);
					}

					return jsonOk(page);
				} catch (e) {
					return toErrorResponse(e, "Couldn't load match history.");
				}
			},
		},
	},
});
