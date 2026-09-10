// Server-only module — do not import from client-side code.

import { z } from 'zod';
import { RATE_LIMIT, RATE_LIMIT_WINDOW_MS } from '@/lib/api/rate-limit';
import {
	matchIdParams,
	matchResultBody,
	recordGameBody,
} from '@/lib/api/schemas';

/**
 * The machine-readable description of `/api/v1`.
 *
 * Request bodies are generated from the **same zod objects the handlers
 * validate with** (`schemas.ts`) via zod 4's native `toJSONSchema`, so a
 * schema change cannot silently leave the spec stale. Responses are
 * described by hand — they are derived from Prisma rows and lib return
 * types rather than from a schema object, so there is nothing to generate
 * them from without inventing a second source of truth.
 *
 * No dependency was added for this: `zod-to-openapi` exists, but zod 4
 * ships JSON Schema conversion, and OpenAPI 3.1 uses JSON Schema
 * proper — so the two line up without a translation layer.
 */

/** Strip the `$schema` key zod emits; OpenAPI supplies its own dialect. */
function schemaFor(schema: z.ZodType): Record<string, unknown> {
	const generated = z.toJSONSchema(schema) as Record<string, unknown>;
	delete generated.$schema;
	return generated;
}

const errorResponse = {
	description: 'Standard error envelope.',
	content: {
		'application/json': {
			schema: {
				type: 'object',
				required: ['error'],
				properties: {
					error: {
						type: 'object',
						required: ['code', 'message'],
						properties: {
							code: {
								type: 'string',
								enum: [
									'bad_request',
									'unauthorized',
									'forbidden',
									'not_found',
									'conflict',
									'rate_limited',
									'internal',
								],
							},
							message: {
								type: 'string',
								description: 'User-facing copy. Never a raw thrown message.',
							},
						},
					},
				},
			},
		},
	},
} as const;

/** Every authenticated endpoint shares these. */
const commonResponses = {
	'401': errorResponse,
	'429': {
		...errorResponse,
		description: `Rate limit exceeded. Includes a Retry-After header. The limit is ${RATE_LIMIT} requests per ${RATE_LIMIT_WINDOW_MS / 1000}s per credential.`,
	},
	'500': errorResponse,
};

const matchIdParameter = {
	name: 'matchId',
	in: 'path',
	required: true,
	schema: schemaFor(matchIdParams).properties
		? (schemaFor(matchIdParams) as { properties: Record<string, unknown> })
				.properties.matchId
		: { type: 'string' },
};

const jsonBody = (schema: z.ZodType) => ({
	required: true,
	content: { 'application/json': { schema: schemaFor(schema) } },
});

export function buildOpenApiSpec() {
	return {
		openapi: '3.1.0',
		info: {
			title: 'Matchmaking API',
			version: '1.0.0',
			description:
				'Read models, game recording and the matchmaking lifecycle. ' +
				'Every endpoint accepts either a Clerk session token or a ' +
				'personal API key, and both resolve to the same user.',
		},
		servers: [{ url: '/api/v1' }],
		components: {
			securitySchemes: {
				// Both credentials arrive as a bearer token; the session
				// cookie path is browser-only and not documented for
				// programmatic clients.
				apiKey: {
					type: 'http',
					scheme: 'bearer',
					description:
						'A personal API key, created at /settings/api-keys. ' +
						'Revocation can take up to a minute to take effect.',
				},
			},
		},
		security: [{ apiKey: [] }],
		paths: {
			'/leaderboard': {
				get: {
					summary: 'The league table, highest rating first.',
					responses: {
						'200': { description: 'Ranked entries.' },
						...commonResponses,
					},
				},
			},
			'/league/activity': {
				get: {
					summary: 'Anonymised league activity for the dashboard.',
					description:
						'Deliberately carries no identifying fields — see the ' +
						'anonymisation contract.',
					responses: {
						'200': { description: 'Activity bundle.' },
						...commonResponses,
					},
				},
			},
			'/me/search': {
				get: {
					summary: "The calling user's active matchmaking search.",
					responses: {
						'200': {
							description:
								'The active search, or null when there is none. ' +
								'Absence is not a 404.',
						},
						...commonResponses,
					},
				},
			},
			'/matches/{matchId}': {
				get: {
					summary: 'Derived state of one match.',
					description: 'Readable only by its players, or an admin.',
					parameters: [matchIdParameter],
					responses: {
						'200': { description: 'Match state.' },
						'403': errorResponse,
						'404': errorResponse,
						...commonResponses,
					},
				},
			},
			'/players/{username}': {
				get: {
					summary: "A player's identity, record and league rank.",
					description:
						'Readable by any authenticated caller — the same facts are ' +
						'already public on the leaderboard.',
					parameters: [
						{
							name: 'username',
							in: 'path',
							required: true,
							schema: { type: 'string' },
						},
					],
					responses: {
						'200': { description: 'The profile.' },
						'404': errorResponse,
						...commonResponses,
					},
				},
			},
			'/players/{username}/ratings': {
				get: {
					summary: "A player's rating after each game they've played.",
					description:
						'Ascending by game time. Does not include the starting-rating ' +
						'point before their first game — that is a presentation ' +
						'concern for the chart, not part of recorded history. Same ' +
						'read-by-anyone stance as /players/{username}.',
					parameters: [
						{
							name: 'username',
							in: 'path',
							required: true,
							schema: { type: 'string' },
						},
					],
					responses: {
						'200': { description: 'Rating history, oldest first.' },
						'404': errorResponse,
						...commonResponses,
					},
				},
			},
			'/games': {
				post: {
					summary: 'Record a completed game.',
					description:
						'The caller must be one of the two players, or an admin. ' +
						'A non-participant receives 403 even when a player id ' +
						'does not exist, so this endpoint cannot be used to probe ' +
						'whether an id is real.',
					requestBody: jsonBody(recordGameBody),
					responses: {
						'201': { description: 'Recorded, with rating changes.' },
						'400': errorResponse,
						'403': errorResponse,
						'404': errorResponse,
						...commonResponses,
					},
				},
			},
			'/search': {
				get: {
					summary: 'Poll the calling user’s search state.',
					responses: {
						'200': { description: 'Derived search state.' },
						...commonResponses,
					},
				},
				post: {
					summary: 'Enter the matchmaking queue.',
					responses: {
						'200': { description: 'Derived search state.' },
						...commonResponses,
					},
				},
			},
			'/search/cancel': {
				post: {
					summary: 'Leave the matchmaking queue.',
					responses: {
						'200': { description: 'Derived search state.' },
						'409': errorResponse,
						...commonResponses,
					},
				},
			},
			'/matches/{matchId}/confirm': {
				post: {
					summary: 'Confirm a proposed match.',
					parameters: [matchIdParameter],
					responses: {
						'200': { description: 'Updated match state.' },
						'403': errorResponse,
						'404': errorResponse,
						'409': errorResponse,
						...commonResponses,
					},
				},
			},
			'/matches/{matchId}/decline': {
				post: {
					summary: 'Decline a proposed match.',
					parameters: [matchIdParameter],
					responses: {
						'200': { description: 'Updated match state.' },
						'403': errorResponse,
						'404': errorResponse,
						'409': errorResponse,
						...commonResponses,
					},
				},
			},
			'/matches/{matchId}/result': {
				post: {
					summary: 'Record the result of a confirmed match.',
					description:
						'`result` is from the reporter’s perspective: "A" means ' +
						'the caller won.',
					parameters: [matchIdParameter],
					requestBody: jsonBody(matchResultBody),
					responses: {
						'201': { description: 'The created game result.' },
						'400': errorResponse,
						'403': errorResponse,
						'404': errorResponse,
						'409': errorResponse,
						...commonResponses,
					},
				},
			},
		},
	};
}
