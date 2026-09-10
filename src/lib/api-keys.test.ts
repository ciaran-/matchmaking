// @vitest-environment node

import { beforeEach, describe, expect, it, vi } from 'vitest';

// ---------- Mocks ----------

vi.mock('@clerk/backend', () => ({
	createClerkClient: vi.fn(),
}));

import type { ClerkClient } from '@clerk/backend';
import { createClerkClient } from '@clerk/backend';
import { issueApiKey, listApiKeys, revokeApiKey } from './api-keys';

const mockCreateClerkClient = vi.mocked(createClerkClient);

// ---------- Test data ----------

const CLERK_ID = 'user_abc123';
const OTHER_CLERK_ID = 'user_someone_else';

/** A Clerk `APIKey` as returned by the SDK, minus the fields we ignore. */
function clerkKey(overrides: Record<string, unknown> = {}) {
	return {
		id: 'ak_id_1',
		name: 'CI bot',
		subject: CLERK_ID,
		createdAt: 1_700_000_000,
		lastUsedAt: null,
		revoked: false,
		// Fields we deliberately do not surface:
		claims: null,
		scopes: [],
		description: 'internal',
		updatedAt: 1_700_000_000,
		...overrides,
	};
}

const apiKeys = {
	create: vi.fn(),
	list: vi.fn(),
	get: vi.fn(),
	revoke: vi.fn(),
	delete: vi.fn(),
	getSecret: vi.fn(),
};

beforeEach(() => {
	vi.clearAllMocks();
	process.env.CLERK_SECRET_KEY = 'sk_test_123';
	process.env.VITE_CLERK_PUBLISHABLE_KEY = 'pk_test_123';
	mockCreateClerkClient.mockReturnValue({
		apiKeys,
	} as unknown as ClerkClient);
});

describe('issueApiKey', () => {
	it('creates a user-scoped key and returns the secret once', async () => {
		apiKeys.create.mockResolvedValue(clerkKey({ secret: 'ak_live_secret' }));

		const { raw, key } = await issueApiKey(CLERK_ID, 'CI bot');

		expect(apiKeys.create).toHaveBeenCalledWith({
			name: 'CI bot',
			subject: CLERK_ID,
		});
		expect(raw).toBe('ak_live_secret');
		expect(key.id).toBe('ak_id_1');
	});

	it('never returns the secret inside the metadata', async () => {
		apiKeys.create.mockResolvedValue(clerkKey({ secret: 'ak_live_secret' }));

		const { key } = await issueApiKey(CLERK_ID, 'CI bot');

		expect(Object.keys(key).sort()).toEqual([
			'createdAt',
			'id',
			'lastUsedAt',
			'name',
			'revoked',
		]);
		expect(JSON.stringify(key)).not.toContain('ak_live_secret');
	});

	it('throws if Clerk returns no secret rather than handing back undefined', async () => {
		apiKeys.create.mockResolvedValue(clerkKey());

		await expect(issueApiKey(CLERK_ID, 'CI bot')).rejects.toThrow(
			'Clerk did not return an API key secret',
		);
	});
});

describe('listApiKeys', () => {
	it('lists the subject’s keys including revoked ones', async () => {
		apiKeys.list.mockResolvedValue({
			data: [clerkKey(), clerkKey({ id: 'ak_id_2', revoked: true })],
			totalCount: 2,
		});

		const keys = await listApiKeys(CLERK_ID);

		expect(apiKeys.list).toHaveBeenCalledWith({
			subject: CLERK_ID,
			includeInvalid: true,
		});
		expect(keys.map((k) => k.id)).toEqual(['ak_id_1', 'ak_id_2']);
		expect(keys[1].revoked).toBe(true);
	});

	it('returns metadata only, dropping Clerk fields we do not surface', async () => {
		apiKeys.list.mockResolvedValue({ data: [clerkKey()], totalCount: 1 });

		const [key] = await listApiKeys(CLERK_ID);

		expect(key).toEqual({
			id: 'ak_id_1',
			name: 'CI bot',
			createdAt: 1_700_000_000,
			lastUsedAt: null,
			revoked: false,
		});
	});

	it('never calls getSecret', async () => {
		apiKeys.list.mockResolvedValue({ data: [clerkKey()], totalCount: 1 });

		await listApiKeys(CLERK_ID);

		expect(apiKeys.getSecret).not.toHaveBeenCalled();
	});
});

describe('revokeApiKey', () => {
	it('revokes a key the caller owns', async () => {
		apiKeys.get.mockResolvedValue(clerkKey());
		apiKeys.revoke.mockResolvedValue(clerkKey({ revoked: true }));

		const key = await revokeApiKey(CLERK_ID, 'ak_id_1');

		expect(apiKeys.revoke).toHaveBeenCalledWith({ apiKeyId: 'ak_id_1' });
		expect(key.revoked).toBe(true);
	});

	it('refuses to revoke another user’s key', async () => {
		apiKeys.get.mockResolvedValue(clerkKey({ subject: OTHER_CLERK_ID }));

		await expect(revokeApiKey(CLERK_ID, 'ak_id_1')).rejects.toThrow(
			'Unauthorized',
		);
		expect(apiKeys.revoke).not.toHaveBeenCalled();
	});

	it('revokes rather than deletes, so the record stays auditable', async () => {
		apiKeys.get.mockResolvedValue(clerkKey());
		apiKeys.revoke.mockResolvedValue(clerkKey({ revoked: true }));

		await revokeApiKey(CLERK_ID, 'ak_id_1');

		expect(apiKeys.delete).not.toHaveBeenCalled();
	});

	it('propagates Clerk errors for the route layer to map', async () => {
		apiKeys.get.mockRejectedValue(
			Object.assign(new Error('API key not found'), { status: 404 }),
		);

		await expect(revokeApiKey(CLERK_ID, 'ak_missing')).rejects.toThrow(
			'API key not found',
		);
	});
});
