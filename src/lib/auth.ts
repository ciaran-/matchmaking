// Server-only module — do not import from client-side code.

import { createClerkClient } from '@clerk/backend';
import type { User } from '@prisma/client';
import { getRequest } from '@tanstack/react-start/server';
import { prisma } from '@/db';

/**
 * Build a Clerk backend client from the environment.
 *
 * `@clerk/backend` does not pick these up automatically —
 * `authenticateRequest` requires **both** keys passed explicitly.
 */
function clerkClient() {
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
export async function authenticatedUser(request?: Request): Promise<User> {
	const clerk = clerkClient();

	let toAuthenticate = request;
	if (!toAuthenticate) {
		const req = getRequest();
		toAuthenticate = new Request(req.url, { headers: req.headers });
	}

	const auth = await clerk.authenticateRequest(toAuthenticate);
	// `isAuthenticated`, not the deprecated `isSignedIn` — it is the only
	// discriminator present on both session and machine auth objects, so
	// `resolveApiUser` can share this shape.
	if (!auth.isAuthenticated) throw new Error('Unauthorized');

	const clerkId = auth.toAuth().userId;
	const dbUser = await prisma.user.findUnique({ where: { clerkId } });
	if (!dbUser) throw new Error('User not found');
	return dbUser;
}
