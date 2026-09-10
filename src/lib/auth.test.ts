// @vitest-environment node

import { beforeEach, describe, expect, it, vi } from 'vitest';

// ---------- Mocks ----------

vi.mock('@tanstack/react-start/server', () => ({
	getRequest: vi.fn(),
}));

vi.mock('@clerk/backend', () => ({
	createClerkClient: vi.fn(),
}));

vi.mock('@/db', () => ({
	prisma: {
		user: {
			findUnique: vi.fn(),
		},
	},
}));

import type { ClerkClient } from '@clerk/backend';
import { createClerkClient } from '@clerk/backend';
import type { User as DbUser } from '@prisma/client';
import { getRequest } from '@tanstack/react-start/server';
import { prisma } from '@/db';
import { authenticatedUser, resolveApiUser } from './auth';

const mockGetRequest = vi.mocked(getRequest);
const mockCreateClerkClient = vi.mocked(createClerkClient);
const mockFindUnique = vi.mocked(prisma.user.findUnique);

// ---------- Test data ----------

const CLERK_ID = 'user_abc123';

const dbUser = {
	id: 'db-user-1',
	clerkId: CLERK_ID,
	currentRating: 1200,
} as DbUser;

/** Stub `authenticateRequest` with a given auth outcome. */
function stubClerk(auth: { isAuthenticated: boolean; userId?: string | null }) {
	const authenticateRequest = vi.fn().mockResolvedValue({
		isAuthenticated: auth.isAuthenticated,
		toAuth: () => ({ userId: auth.userId ?? null }),
	});
	mockCreateClerkClient.mockReturnValue({
		authenticateRequest,
	} as unknown as ClerkClient);
	return authenticateRequest;
}

beforeEach(() => {
	vi.clearAllMocks();
	process.env.CLERK_SECRET_KEY = 'sk_test_123';
	process.env.VITE_CLERK_PUBLISHABLE_KEY = 'pk_test_123';
	mockGetRequest.mockReturnValue(
		new Request('https://example.test/api', {
			headers: { cookie: '__session=abc' },
		}),
	);
});

describe('authenticatedUser', () => {
	it('throws when Clerk env vars are missing', async () => {
		process.env.CLERK_SECRET_KEY = '';

		await expect(authenticatedUser()).rejects.toThrow('Missing Clerk env vars');
		expect(mockCreateClerkClient).not.toHaveBeenCalled();
	});

	it('passes both keys explicitly to the Clerk client', async () => {
		stubClerk({ isAuthenticated: true, userId: CLERK_ID });
		mockFindUnique.mockResolvedValue(dbUser);

		await authenticatedUser();

		expect(mockCreateClerkClient).toHaveBeenCalledWith({
			secretKey: 'sk_test_123',
			publishableKey: 'pk_test_123',
		});
	});

	it('throws Unauthorized when the request is not authenticated', async () => {
		stubClerk({ isAuthenticated: false });

		await expect(authenticatedUser()).rejects.toThrow('Unauthorized');
		expect(mockFindUnique).not.toHaveBeenCalled();
	});

	it('throws User not found when Clerk resolves but no DB row exists', async () => {
		stubClerk({ isAuthenticated: true, userId: CLERK_ID });
		mockFindUnique.mockResolvedValue(null);

		await expect(authenticatedUser()).rejects.toThrow('User not found');
	});

	it('returns the DB user looked up by clerkId on the happy path', async () => {
		stubClerk({ isAuthenticated: true, userId: CLERK_ID });
		mockFindUnique.mockResolvedValue(dbUser);

		await expect(authenticatedUser()).resolves.toEqual(dbUser);
		expect(mockFindUnique).toHaveBeenCalledWith({
			where: { clerkId: CLERK_ID },
		});
	});

	describe('request selection', () => {
		it('authenticates a headers-only clone of the ambient request when none is passed', async () => {
			const authenticateRequest = stubClerk({
				isAuthenticated: true,
				userId: CLERK_ID,
			});
			mockFindUnique.mockResolvedValue(dbUser);

			await authenticatedUser();

			expect(mockGetRequest).toHaveBeenCalled();
			const passed = authenticateRequest.mock.calls[0][0] as Request;
			expect(passed).not.toBe(mockGetRequest.mock.results[0].value);
			expect(passed.url).toBe('https://example.test/api');
			expect(passed.headers.get('cookie')).toBe('__session=abc');
		});

		it('authenticates an explicitly passed request without touching getRequest', async () => {
			const authenticateRequest = stubClerk({
				isAuthenticated: true,
				userId: CLERK_ID,
			});
			mockFindUnique.mockResolvedValue(dbUser);

			const apiRequest = new Request(
				'https://example.test/api/v1/leaderboard',
				{
					method: 'POST',
					headers: { authorization: 'Bearer sess_token' },
					body: JSON.stringify({ hello: 'world' }),
				},
			);

			await authenticatedUser(apiRequest);

			expect(mockGetRequest).not.toHaveBeenCalled();
			expect(authenticateRequest).toHaveBeenCalledWith(apiRequest);
			// The handler must still be able to read the body afterwards.
			expect(apiRequest.bodyUsed).toBe(false);
		});
	});
});

describe('resolveApiUser', () => {
	/** Stub `authenticateRequest` and capture the options it was called with. */
	function stubDualClerk(auth: {
		isAuthenticated: boolean;
		userId?: string | null;
		orgId?: string | null;
	}) {
		const authenticateRequest = vi.fn().mockResolvedValue({
			isAuthenticated: auth.isAuthenticated,
			toAuth: () => ({
				userId: auth.userId ?? null,
				orgId: auth.orgId ?? null,
			}),
		});
		mockCreateClerkClient.mockReturnValue({
			authenticateRequest,
		} as unknown as ClerkClient);
		return authenticateRequest;
	}

	const apiRequest = () =>
		new Request('https://example.test/api/v1/leaderboard', {
			headers: { authorization: 'Bearer ak_live_key' },
		});

	it('accepts session tokens, API keys and machine tokens, and nothing else', async () => {
		const authenticateRequest = stubDualClerk({
			isAuthenticated: true,
			userId: CLERK_ID,
		});
		mockFindUnique.mockResolvedValue(dbUser);

		const request = apiRequest();
		await resolveApiUser(request);

		expect(authenticateRequest).toHaveBeenCalledWith(request, {
			acceptsToken: ['session_token', 'api_key', 'm2m_token'],
		});
	});

	it('refuses a service credential, which is not a user', async () => {
		// resolveApiUser narrows to a person. A machine token authenticates
		// fine but has nobody behind it, and every endpoint using this
		// helper needs a User row.
		const authenticateRequest = vi.fn().mockResolvedValue({
			isAuthenticated: true,
			toAuth: () => ({ tokenType: 'm2m_token', subject: 'mch_abc' }),
		});
		mockCreateClerkClient.mockReturnValue({
			authenticateRequest,
		} as unknown as ClerkClient);

		await expect(resolveApiUser(apiRequest())).rejects.toThrow(
			'requires a user',
		);
		expect(mockFindUnique).not.toHaveBeenCalled();
	});

	it('resolves an API key to the DB user', async () => {
		stubDualClerk({ isAuthenticated: true, userId: CLERK_ID });
		mockFindUnique.mockResolvedValue(dbUser);

		await expect(resolveApiUser(apiRequest())).resolves.toEqual(dbUser);
		expect(mockFindUnique).toHaveBeenCalledWith({
			where: { clerkId: CLERK_ID },
		});
	});

	it('rejects an invalid or revoked credential', async () => {
		stubDualClerk({ isAuthenticated: false });

		await expect(resolveApiUser(apiRequest())).rejects.toThrow('Unauthorized');
		expect(mockFindUnique).not.toHaveBeenCalled();
	});

	it('rejects an org-scoped key, which authenticates with a null userId', async () => {
		stubDualClerk({
			isAuthenticated: true,
			userId: null,
			orgId: 'org_abc',
		});

		await expect(resolveApiUser(apiRequest())).rejects.toThrow('Unauthorized');
		// Never reaches a lookup against a null clerkId.
		expect(mockFindUnique).not.toHaveBeenCalled();
	});

	it('throws User not found when the credential resolves to no DB row', async () => {
		stubDualClerk({ isAuthenticated: true, userId: CLERK_ID });
		mockFindUnique.mockResolvedValue(null);

		await expect(resolveApiUser(apiRequest())).rejects.toThrow(
			'User not found',
		);
	});

	it('does not consume the request body', async () => {
		stubDualClerk({ isAuthenticated: true, userId: CLERK_ID });
		mockFindUnique.mockResolvedValue(dbUser);

		const request = new Request('https://example.test/api/v1/games', {
			method: 'POST',
			headers: { authorization: 'Bearer ak_live_key' },
			body: JSON.stringify({ result: 'A' }),
		});
		await resolveApiUser(request);

		expect(request.bodyUsed).toBe(false);
		await expect(request.json()).resolves.toEqual({ result: 'A' });
	});
});
