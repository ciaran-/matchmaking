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
import { authenticatedUser } from './auth';

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
