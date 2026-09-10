// @vitest-environment node

import type { ClerkClient, createClerkClient } from '@clerk/backend';
import type { MockedFunction } from 'vitest';
import { vi } from 'vitest';

/**
 * HTTP-level test harness for the REST API.
 *
 * TanStack Start server routes expose their handlers as plain functions
 * at `Route.options.server.handlers.<METHOD>`, so a test can invoke one
 * directly with a real `Request` — no server to boot, no port to bind.
 * That exercises everything the adapter owns (auth, validation,
 * delegation, envelope, status) against a real database.
 *
 * Pair with `createTestDatabase` from `@/test/db` for the DB half, and
 * `stubClerkCredential` below for the auth half.
 */

/** The shape TanStack Start passes to a server-route method handler. */
type RouteHandlerCtx = {
	request: Request;
	params: Record<string, string>;
	pathname: string;
	context: Record<string, unknown>;
	next: () => never;
};

export type RouteHandler = (
	ctx: RouteHandlerCtx,
) => Response | Promise<Response>;

/**
 * Invoke a route handler with a real `Request`.
 *
 * @param params - Path params the router would have parsed, e.g.
 * `{ matchId: 'm1' }` for `/api/v1/matches/$matchId`.
 */
export async function callRoute(
	handler: RouteHandler,
	request: Request,
	params: Record<string, string> = {},
): Promise<Response> {
	return handler({
		request,
		params,
		pathname: new URL(request.url).pathname,
		context: {},
		next: () => {
			throw new Error('next() is not supported in the test harness');
		},
	});
}

/** Read a JSON response as `{ status, body }` in one step. */
export async function readJson<T = unknown>(
	response: Response,
): Promise<{ status: number; body: T }> {
	return { status: response.status, body: (await response.json()) as T };
}

/**
 * The credential a test presents.
 *
 * `apiKey` and `session` differ only in what Clerk reports back, which is
 * the honest boundary: Clerk is mocked here, so these tests prove our
 * adapter treats both credentials identically — not that Clerk verifies
 * them correctly, which is Clerk's own contract.
 */
export type Credential =
	| { kind: 'apiKey'; clerkUserId: string }
	| { kind: 'session'; clerkUserId: string }
	/** Authenticates as an org-scoped key: valid, but carries no user. */
	| { kind: 'orgKey'; orgId: string }
	| { kind: 'invalid' };

/**
 * Point the mocked Clerk SDK at a given credential outcome.
 *
 * Call inside `beforeEach`, after `vi.mock('@clerk/backend', ...)` in the
 * test file. Returns the `authenticateRequest` spy so a test can assert
 * on how it was called.
 */
export function stubClerkCredential(
	createClerkClientMock: MockedFunction<typeof createClerkClient>,
	credential: Credential,
) {
	const authenticateRequest = vi.fn().mockResolvedValue(
		credential.kind === 'invalid'
			? { isAuthenticated: false, toAuth: () => null }
			: {
					isAuthenticated: true,
					toAuth: () => ({
						tokenType:
							credential.kind === 'session' ? 'session_token' : 'api_key',
						userId: 'clerkUserId' in credential ? credential.clerkUserId : null,
						orgId: 'orgId' in credential ? credential.orgId : null,
					}),
				},
	);

	createClerkClientMock.mockReturnValue({
		authenticateRequest,
	} as unknown as ClerkClient);

	return authenticateRequest;
}

/**
 * Build a request carrying a credential, shaped the way a real client
 * would send it. The header is cosmetic while Clerk is mocked, but keeps
 * the tests readable and ready for a live-credential variant later.
 */
export function apiRequest(
	url: string,
	init: RequestInit & { credential?: Credential } = {},
): Request {
	const { credential, ...rest } = init;
	const headers = new Headers(rest.headers);

	if (credential?.kind === 'apiKey' || credential?.kind === 'orgKey') {
		headers.set('authorization', 'Bearer ak_test_key');
	} else if (credential?.kind === 'session') {
		headers.set('cookie', '__session=test_session_jwt');
	}

	return new Request(url, { ...rest, headers });
}
