// Server-only module — do not import from client-side code.

import { createClerkClient } from '@clerk/backend';
import type { User } from '@prisma/client';
import { getRequest } from '@tanstack/react-start/server';
import { prisma } from '@/db';

/**
 * A `User` that is definitionally Clerk-backed.
 *
 * `User.clerkId` is nullable in the schema (seed and legacy rows have
 * none), but a user resolved *by* clerkId always has one. Narrowing it
 * here spares every caller a redundant null check before handing the id
 * back to Clerk.
 */
export type AuthenticatedUser = User & { clerkId: string };

/**
 * Build a Clerk backend client from the environment.
 *
 * Exported so every server-side Clerk call in the app (auth, API keys)
 * constructs the client the same way.
 *
 * `@clerk/backend` does not pick these up automatically —
 * `authenticateRequest` requires **both** keys passed explicitly.
 */
export function clerkClient() {
	const secretKey = process.env.CLERK_SECRET_KEY;
	const publishableKey = process.env.VITE_CLERK_PUBLISHABLE_KEY;
	if (!secretKey || !publishableKey) {
		throw new Error('Missing Clerk env vars');
	}
	return createClerkClient({ secretKey, publishableKey });
}

/**
 * Resolve the authenticated user for the current request: performs the
 * Clerk auth dance and loads the corresponding `User` row.
 *
 * Accepts a **session token only**. Programmatic clients presenting a
 * personal API key go through `resolveApiUser` (T5) instead.
 *
 * @param request - The request to authenticate. **API routes must pass
 * their handler's `request`**, whose body has not been consumed. Omit it
 * inside `createServerFn` handlers: there is no explicit request to hand
 * over, and TanStack Start has already consumed the ambient request's
 * body to deserialize the server-function arguments — so that path
 * authenticates a headers-only clone.
 *
 * Throws on missing env, missing/invalid credentials, or if the Clerk
 * user has no matching `User` row.
 */
export async function authenticatedUser(
	request?: Request,
): Promise<AuthenticatedUser> {
	const clerk = clerkClient();

	let toAuthenticate = request;
	if (!toAuthenticate) {
		const req = getRequest();
		toAuthenticate = new Request(req.url, { headers: req.headers });
	}

	const auth = await clerk.authenticateRequest(toAuthenticate);
	// `isAuthenticated`, not the deprecated `isSignedIn` — it is the only
	// discriminator present on both session and machine auth objects, so
	// `resolveApiUser` shares this shape.
	if (!auth.isAuthenticated) throw new Error('Unauthorized');

	return userForClerkId(auth.toAuth().userId);
}

/**
 * Resolve the user behind an API request, accepting **either** credential:
 * a Clerk session token (what the web app sends) or a personal API key
 * (`Authorization: Bearer ak_…`, what scripts and mobile clients send).
 *
 * Both resolve to the same `User`, so everything downstream is identical
 * regardless of which was presented — that is the whole point of the dual
 * credential model.
 *
 * No prefix sniffing here on purpose: `acceptsToken` makes Clerk do the
 * disambiguation, and listing the two types explicitly means an M2M or
 * OAuth token is rejected rather than silently accepted. Service
 * identities are an explicit non-goal of this feature.
 */
/**
 * Who is calling. Either a person, or the system itself.
 *
 * A union rather than always-a-`User` because a service caller has no
 * human behind it — `resolveApiUser` used to guarantee a `User` row, and
 * everything downstream leaned on that guarantee.
 */
export type Actor =
	| { kind: 'user'; user: AuthenticatedUser }
	| { kind: 'service'; machineId: string };

/**
 * Resolve the actor behind an API request.
 *
 * Accepts three credentials, all verified by Clerk:
 *
 * - a **session token** — the browser,
 * - a **personal API key** (`ak_…`) — a script acting *as a user*,
 * - a **machine-to-machine token** (`mt_…`) — the system acting as
 *   itself, with no person behind it.
 *
 * The first two resolve to the same `User`, so endpoints cannot tell a
 * PAT from a browser session and should not try. The third resolves to a
 * service, which most endpoints should refuse — see `requireUser`.
 *
 * OAuth tokens (`oat_`) are deliberately excluded: we are not a
 * third-party developer platform, and listing a token type here is what
 * makes it acceptable.
 */
/**
 * Per-request memo.
 *
 * Both `apiMiddleware` and the route handler resolve the actor for the
 * same request — the middleware to enforce default-deny, the handler to
 * use the result. Verifying twice would mean two Clerk round trips per
 * request, and for a personal API key that verification is a network
 * call, not a local JWT check.
 *
 * Keyed on the `Request` instance, which is unique per request and
 * garbage-collected with it. If the framework ever hands the handler a
 * different instance than the middleware saw, this simply misses and we
 * verify twice — the previous behaviour, not a correctness problem.
 */
const actorByRequest = new WeakMap<Request, Promise<Actor>>();

export async function resolveActor(request: Request): Promise<Actor> {
	const memoized = actorByRequest.get(request);
	if (memoized) return memoized;

	const pending = resolveActorUncached(request);
	actorByRequest.set(request, pending);
	// A rejected promise must not be cached: a transient Clerk failure
	// would otherwise stick to this request for its whole lifetime.
	pending.catch(() => actorByRequest.delete(request));
	return pending;
}

async function resolveActorUncached(request: Request): Promise<Actor> {
	const clerk = clerkClient();

	const auth = await clerk.authenticateRequest(request, {
		acceptsToken: ['session_token', 'api_key', 'm2m_token'],
	});
	if (!auth.isAuthenticated) throw new Error('Unauthorized');

	const resolved = auth.toAuth();

	if (resolved.tokenType === 'm2m_token') {
		// A machine token's subject is the machine, not a user.
		const machineId = resolved.subject ?? resolved.id;
		if (!machineId) throw new Error('Unauthorized');
		return { kind: 'service', machineId };
	}

	// An org-scoped API key authenticates successfully but carries no
	// user — `{ userId: null, orgId: 'org_…' }`. This API is user-scoped
	// only, so that is a 401, not a lookup against a null id.
	const { userId } = resolved;
	if (!userId) throw new Error('Unauthorized');

	return { kind: 'user', user: await userForClerkId(userId) };
}

/**
 * Narrow an actor to a person, or refuse.
 *
 * Most endpoints are meaningless for a service: starting a matchmaking
 * search, reading "my" profile, minting a personal API key. Rather than
 * each one re-checking `kind`, they call this and get the `User` they
 * already expected.
 */
export function requireUser(actor: Actor): AuthenticatedUser {
	if (actor.kind !== 'user') {
		throw new Error('This endpoint requires a user, not a service');
	}
	return actor.user;
}

/**
 * Backwards-compatible shim: resolve a request to a `User`, refusing a
 * service credential.
 *
 * Every existing endpoint wants a person, so they keep calling this and
 * behave exactly as before. New endpoints that genuinely serve the system
 * call `resolveActor` directly.
 */
export async function resolveApiUser(
	request: Request,
): Promise<AuthenticatedUser> {
	return requireUser(await resolveActor(request));
}

/** Load the `User` row behind a Clerk user id. */
async function userForClerkId(clerkId: string): Promise<AuthenticatedUser> {
	const dbUser = await prisma.user.findUnique({ where: { clerkId } });
	if (!dbUser) throw new Error('User not found');
	// Looked up by a non-null clerkId, so the row carries it.
	return dbUser as AuthenticatedUser;
}
