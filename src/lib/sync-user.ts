// Server-only module — do not import from client-side code.
// Uses @clerk/backend for session verification (createClerkClient is not
// available from @clerk/clerk-react v5).

import type { User as ClerkUser } from '@clerk/backend';
import { createClerkClient } from '@clerk/backend';
import type { User } from '@prisma/client';
import { getCookie, getRequest, setCookie } from '@tanstack/react-start/server';
import { prisma } from '@/db';

// ---------- Helpers ----------

export function isPrismaUniqueConstraintError(e: unknown): boolean {
	return (
		typeof e === 'object' &&
		e !== null &&
		'code' in e &&
		(e as { code: string }).code === 'P2002'
	);
}

export async function deriveUniqueUsername(
	clerkUser: ClerkUser,
): Promise<string> {
	const base = deriveBaseUsername(clerkUser);

	// Try the base name first, then up to 5 suffixed variants.
	for (let attempt = 0; attempt <= 5; attempt++) {
		const candidate =
			attempt === 0
				? base
				: `${base}${Math.floor(1000 + Math.random() * 9000)}`;
		// We attempt the upsert at the call-site; here we just check uniqueness
		// by trying a findUnique. If null, the name is available.
		const existing = await prisma.user.findUnique({
			where: { username: candidate },
		});
		if (!existing) return candidate;
	}

	throw new Error(
		`[deriveUniqueUsername] Could not derive a unique username for Clerk user ${clerkUser.id} after 5 attempts`,
	);
}

function deriveBaseUsername(clerkUser: ClerkUser): string {
	// Priority 1: Clerk username
	if (clerkUser.username) return clerkUser.username;

	// Priority 2: firstName + lastName
	const fullName = [clerkUser.firstName, clerkUser.lastName]
		.filter(Boolean)
		.join('')
		.toLowerCase()
		.replace(/\s+/g, '');
	if (fullName) return fullName;

	// Priority 3: email prefix
	const email = clerkUser.emailAddresses?.[0]?.emailAddress ?? '';
	const emailPrefix = email.split('@')[0];
	if (emailPrefix) return emailPrefix;

	// Fallback (should never happen if Clerk requires at least one contact method)
	return `user${Math.floor(1000 + Math.random() * 9000)}`;
}

// ---------- Main export ----------

export async function syncUser(): Promise<User | null> {
	// CLERK_SECRET_KEY is read here, inside the function body, intentionally.
	// Do not move it to module scope — Vite can accidentally bundle module-scope
	// process.env references into the client bundle.
	const secretKey = process.env.CLERK_SECRET_KEY;
	if (!secretKey) {
		throw new Error('Missing required environment variable: CLERK_SECRET_KEY');
	}
	const publishableKey = process.env.VITE_CLERK_PUBLISHABLE_KEY;
	if (!publishableKey) {
		throw new Error('Missing required environment variable: VITE_CLERK_PUBLISHABLE_KEY');
	}
	const clerk = createClerkClient({ secretKey, publishableKey });

	const request = getRequest();
	const auth = await clerk.authenticateRequest(request);

	if (!auth.isSignedIn) return null;

	const clerkUserId = auth.toAuth().userId;

	// Cookie fast-path: if db_synced matches the current Clerk user, check for
	// the existing DB row and only skip the upsert when it is actually present.
	const syncedId = getCookie('db_synced');
	if (syncedId === clerkUserId) {
		const existingUser = await prisma.user.findUnique({
			where: { clerkId: clerkUserId },
		});
		if (existingUser) {
			return existingUser;
		}
		// Stale cookie: clear it and fall through to the normal sync/upsert path.
		setCookie('db_synced', '', {
			httpOnly: true,
			sameSite: 'lax',
			secure: process.env.NODE_ENV === 'production',
			maxAge: 0,
			path: '/',
		});
	}

	// No matching cookie — fetch full user details from Clerk and upsert.
	const clerkUser = await clerk.users.getUser(clerkUserId);

	let dbUser: User;
	try {
		dbUser = await prisma.user.upsert({
			where: { clerkId: clerkUserId },
			create: {
				clerkId: clerkUserId,
				email: (() => {
					const addr = clerkUser.emailAddresses[0]?.emailAddress;
					if (!addr)
						throw new Error(`Clerk user ${clerkUserId} has no email address`);
					return addr;
				})(),
				username: await deriveUniqueUsername(clerkUser),
				currentRating: 1000,
			},
			update: {
				// Intentionally empty — never overwrite username or rating after creation.
				// Email update is omitted: if the Clerk email collides with a seed user's
				// unique constraint it would throw; revisit when seed data is removed.
			},
		});
	} catch (e) {
		// P2002 means a race condition: two tabs signed in simultaneously and the
		// other request won the INSERT. Fall back to fetching the row that was created.
		if (isPrismaUniqueConstraintError(e)) {
			const existing = await prisma.user.findUnique({
				where: { clerkId: clerkUserId },
			});
			if (existing) {
				return existing;
			}
		}
		throw e;
	}

	// Set the sync cookie so subsequent page loads skip the upsert.
	setCookie('db_synced', clerkUserId, {
		httpOnly: true,
		sameSite: 'lax',
		secure: process.env.NODE_ENV === 'production',
		maxAge: 3600,
		path: '/',
	});

	return dbUser;
}
