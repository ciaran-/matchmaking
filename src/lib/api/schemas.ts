// Server-only module — do not import from client-side code.

import { z } from 'zod';

/**
 * Request schemas for `/api/v1`.
 *
 * These live here rather than beside their handlers so the OpenAPI spec
 * can be generated from the *same* objects the routes validate with. A
 * spec written separately from the code it documents drifts from it, and
 * a wrong spec is worse than none — clients build against it.
 */

/** `POST /api/v1/games` */
export const recordGameBody = z.object({
	playerAId: z.string(),
	playerBId: z.string(),
	result: z.enum(['A', 'B', 'draw']),
});

/**
 * `POST /api/v1/matches/:matchId/result`
 *
 * `result` is from the **reporter's** perspective — `'A'` means "I, the
 * caller, won" — not from `playerAId`/`playerBId`.
 */
export const matchResultBody = z.object({
	result: z.enum(['A', 'B', 'draw']),
});

/** Path params for every `/api/v1/matches/:matchId/*` route. */
export const matchIdParams = z.object({ matchId: z.string().uuid() });
