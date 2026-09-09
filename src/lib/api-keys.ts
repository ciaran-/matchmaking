// Server-only module — do not import from client-side code.

import { clerkClient } from '@/lib/auth';

/**
 * Personal API keys ("PATs") for programmatic clients.
 *
 * These are thin wrappers over Clerk's native, user-scoped API keys —
 * Clerk owns the key store, so there is deliberately **no Prisma model,
 * no migration, and no hashing of our own**. See
 * `.claude/plans/feature-6-api-conventions.md` §8 for the SDK surface.
 *
 * The raw secret exists in exactly one place in this app's lifetime: the
 * return value of `issueApiKey`. It is never persisted, never logged, and
 * never re-read (Clerk's `getSecret` is deliberately not called).
 */

/**
 * Everything safe to show a user about one of their keys. Notably absent:
 * the secret.
 *
 * Clerk's `APIKey` has no prefix/last-four field, so a key is identified
 * in the UI by its name and creation date — which is why `name` is
 * required at issue time.
 */
export type ApiKeyMetadata = {
	id: string;
	name: string;
	createdAt: number;
	lastUsedAt: number | null;
	revoked: boolean;
};

function toMetadata(key: {
	id: string;
	name: string;
	createdAt: number;
	lastUsedAt: number | null;
	revoked: boolean;
}): ApiKeyMetadata {
	return {
		id: key.id,
		name: key.name,
		createdAt: key.createdAt,
		lastUsedAt: key.lastUsedAt,
		revoked: key.revoked,
	};
}

/**
 * Mint a new personal API key for a user.
 *
 * `raw` is the only time the secret is available — show it to the user
 * once and discard it. Callers must not log or store it.
 */
export async function issueApiKey(
	clerkUserId: string,
	name: string,
): Promise<{ raw: string; key: ApiKeyMetadata }> {
	const clerk = clerkClient();
	const created = await clerk.apiKeys.create({ name, subject: clerkUserId });

	if (!created.secret) {
		throw new Error('Clerk did not return an API key secret');
	}

	return { raw: created.secret, key: toMetadata(created) };
}

/**
 * List a user's keys as metadata only. Includes revoked keys so the UI
 * can show that a key was retired rather than silently dropping it.
 */
export async function listApiKeys(
	clerkUserId: string,
): Promise<ApiKeyMetadata[]> {
	const clerk = clerkClient();
	const { data } = await clerk.apiKeys.list({
		subject: clerkUserId,
		includeInvalid: true,
	});
	return data.map(toMetadata);
}

/**
 * Revoke one of the calling user's keys.
 *
 * Revokes rather than deletes: Clerk keeps the record with `revoked:
 * true`, so a retired key stays auditable.
 *
 * Ownership is checked before revoking — a key id is guessable enough
 * that acting on it without confirming the subject would let any signed-in
 * user retire another user's credential.
 */
export async function revokeApiKey(
	clerkUserId: string,
	keyId: string,
): Promise<ApiKeyMetadata> {
	const clerk = clerkClient();

	const existing = await clerk.apiKeys.get(keyId);
	if (existing.subject !== clerkUserId) {
		throw new Error('Unauthorized');
	}

	const revoked = await clerk.apiKeys.revoke({ apiKeyId: keyId });
	return toMetadata(revoked);
}
