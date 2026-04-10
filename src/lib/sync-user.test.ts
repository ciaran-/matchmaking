// @vitest-environment node

import { describe, it, expect, vi, beforeEach } from 'vitest'

// ---------- Mocks ----------

vi.mock('@tanstack/start-server-core', () => ({
	getRequest: vi.fn(),
	getCookie: vi.fn(),
	setCookie: vi.fn(),
}))

vi.mock('@clerk/backend', () => ({
	createClerkClient: vi.fn(),
}))

vi.mock('@/db', () => ({
	prisma: {
		user: {
			findUnique: vi.fn(),
			upsert: vi.fn(),
		},
	},
}))

import { createClerkClient } from '@clerk/backend'
import { getCookie, setCookie, getRequest } from '@tanstack/start-server-core'
import { prisma } from '@/db'
import {
	isPrismaUniqueConstraintError,
	deriveUniqueUsername,
	syncUser,
} from './sync-user'

const mockGetRequest = vi.mocked(getRequest)
const mockGetCookie = vi.mocked(getCookie)
const mockSetCookie = vi.mocked(setCookie)
const mockCreateClerkClient = vi.mocked(createClerkClient)
const mockFindUnique = vi.mocked(prisma.user.findUnique)
const mockUpsert = vi.mocked(prisma.user.upsert)

// ---------- Test data ----------

const CLERK_USER_ID = 'user_abc123'

const makeClerkUser = (overrides: Partial<{
	id: string
	username: string | null
	firstName: string | null
	lastName: string | null
	emailAddresses: Array<{ emailAddress: string }>
}> = {}) => ({
	id: CLERK_USER_ID,
	username: null,
	firstName: null,
	lastName: null,
	emailAddresses: [{ emailAddress: 'test@example.com' }],
	...overrides,
})

const makeDbUser = (overrides = {}) => ({
	id: 'db-user-id',
	clerkId: CLERK_USER_ID,
	email: 'test@example.com',
	username: 'testuser',
	currentRating: 1000,
	createdAt: new Date(),
	updatedAt: new Date(),
	...overrides,
})

const makeClerkClient = (overrides: {
	isSignedIn?: boolean
	userId?: string
	clerkUser?: ReturnType<typeof makeClerkUser>
} = {}) => {
	const { isSignedIn = true, userId = CLERK_USER_ID, clerkUser = makeClerkUser() } = overrides
	return {
		authenticateRequest: vi.fn().mockResolvedValue({
			isSignedIn,
			toAuth: () => ({ userId }),
		}),
		users: {
			getUser: vi.fn().mockResolvedValue(clerkUser),
		},
	}
}

// ---------- Tests ----------

describe('isPrismaUniqueConstraintError', () => {
	it('returns true for a P2002 error object', () => {
		expect(isPrismaUniqueConstraintError({ code: 'P2002' })).toBe(true)
	})

	it('returns false for a different Prisma error code', () => {
		expect(isPrismaUniqueConstraintError({ code: 'P2001' })).toBe(false)
	})

	it('returns false for a plain Error instance', () => {
		expect(isPrismaUniqueConstraintError(new Error('something'))).toBe(false)
	})

	it('returns false for null', () => {
		expect(isPrismaUniqueConstraintError(null)).toBe(false)
	})

	it('returns false for undefined', () => {
		expect(isPrismaUniqueConstraintError(undefined)).toBe(false)
	})

	it('returns false for a plain string', () => {
		expect(isPrismaUniqueConstraintError('P2002')).toBe(false)
	})
})

describe('deriveUniqueUsername', () => {
	beforeEach(() => {
		vi.clearAllMocks()
	})

	it('uses the Clerk username when set', async () => {
		mockFindUnique.mockResolvedValueOnce(null) // username not taken
		const user = makeClerkUser({ username: 'alice' })
		const result = await deriveUniqueUsername(user as any)
		expect(result).toBe('alice')
	})

	it('falls back to firstName + lastName when no username', async () => {
		mockFindUnique.mockResolvedValueOnce(null)
		const user = makeClerkUser({ firstName: 'Alice', lastName: 'Smith' })
		const result = await deriveUniqueUsername(user as any)
		expect(result).toBe('alicesmith')
	})

	it('handles firstName only (no lastName)', async () => {
		mockFindUnique.mockResolvedValueOnce(null)
		const user = makeClerkUser({ firstName: 'Alice', lastName: null })
		const result = await deriveUniqueUsername(user as any)
		expect(result).toBe('alice')
	})

	it('falls back to email prefix when no name fields', async () => {
		mockFindUnique.mockResolvedValueOnce(null)
		const user = makeClerkUser({ emailAddresses: [{ emailAddress: 'alice@example.com' }] })
		const result = await deriveUniqueUsername(user as any)
		expect(result).toBe('alice')
	})

	it('appends a 4-digit suffix and retries when username is taken', async () => {
		// First call: base name is taken; second call: suffixed name is free
		mockFindUnique
			.mockResolvedValueOnce(makeDbUser({ username: 'alice' })) // taken
			.mockResolvedValueOnce(null) // free

		const user = makeClerkUser({ username: 'alice' })
		const result = await deriveUniqueUsername(user as any)

		expect(result).toMatch(/^alice\d{4}$/)
	})

	it('throws after 5 failed retries', async () => {
		// All 6 attempts (base + 5 suffixed) return an existing user
		mockFindUnique.mockResolvedValue(makeDbUser() as any)

		const user = makeClerkUser({ username: 'alice' })
		await expect(deriveUniqueUsername(user as any)).rejects.toThrow(
			'Could not derive a unique username',
		)
	})
})

describe('syncUser', () => {
	beforeEach(() => {
		vi.clearAllMocks()
		process.env.CLERK_SECRET_KEY = 'test_secret_key'
		mockGetRequest.mockReturnValue(new Request('http://localhost/'))
	})

	it('returns null when there is no Clerk session', async () => {
		const clerk = makeClerkClient({ isSignedIn: false })
		mockCreateClerkClient.mockReturnValue(clerk as any)

		const result = await syncUser()

		expect(result).toBeNull()
		expect(mockGetCookie).not.toHaveBeenCalled()
		expect(mockUpsert).not.toHaveBeenCalled()
		expect(mockSetCookie).not.toHaveBeenCalled()
	})

	it('returns findUnique result and skips upsert when db_synced cookie matches', async () => {
		const clerk = makeClerkClient()
		mockCreateClerkClient.mockReturnValue(clerk as any)
		mockGetCookie.mockReturnValue(CLERK_USER_ID) // cookie matches
		const dbUser = makeDbUser()
		mockFindUnique.mockResolvedValueOnce(dbUser as any)

		const result = await syncUser()

		expect(result).toEqual(dbUser)
		expect(clerk.users.getUser).not.toHaveBeenCalled()
		expect(mockUpsert).not.toHaveBeenCalled()
		expect(mockSetCookie).not.toHaveBeenCalled()
	})

	it('runs upsert and sets cookie when no db_synced cookie is present', async () => {
		const clerkUser = makeClerkUser({ username: 'alice' })
		const clerk = makeClerkClient({ clerkUser })
		mockCreateClerkClient.mockReturnValue(clerk as any)
		mockGetCookie.mockReturnValue(undefined) // no cookie
		mockFindUnique.mockResolvedValueOnce(null) // username not taken
		const dbUser = makeDbUser()
		mockUpsert.mockResolvedValueOnce(dbUser as any)

		const result = await syncUser()

		expect(mockUpsert).toHaveBeenCalledOnce()
		expect(mockSetCookie).toHaveBeenCalledWith('db_synced', CLERK_USER_ID, expect.objectContaining({
			httpOnly: true,
			sameSite: 'lax',
			maxAge: 3600,
		}))
		expect(result).toEqual(dbUser)
	})

	it('runs upsert when cookie is present but belongs to a different user', async () => {
		const clerkUser = makeClerkUser({ username: 'alice' })
		const clerk = makeClerkClient({ clerkUser })
		mockCreateClerkClient.mockReturnValue(clerk as any)
		mockGetCookie.mockReturnValue('user_different_id') // mismatched cookie
		mockFindUnique.mockResolvedValueOnce(null) // username not taken
		const dbUser = makeDbUser()
		mockUpsert.mockResolvedValueOnce(dbUser as any)

		const result = await syncUser()

		expect(mockUpsert).toHaveBeenCalledOnce()
		expect(result).toEqual(dbUser)
	})

	it('handles race condition: returns existing row when upsert throws P2002', async () => {
		const clerkUser = makeClerkUser({ username: 'alice' })
		const clerk = makeClerkClient({ clerkUser })
		mockCreateClerkClient.mockReturnValue(clerk as any)
		mockGetCookie.mockReturnValue(undefined)
		const existingRow = makeDbUser()
		mockFindUnique
			.mockResolvedValueOnce(null) // username not taken (for deriveUniqueUsername)
			.mockResolvedValueOnce(existingRow as any) // existing row found after race

		mockUpsert.mockRejectedValueOnce({ code: 'P2002' }) // simulate race condition

		const result = await syncUser()

		expect(result).toEqual(existingRow)
		expect(mockSetCookie).not.toHaveBeenCalled() // cookie not set on race fallback
	})

	it('re-throws unexpected DB errors from upsert', async () => {
		const clerkUser = makeClerkUser({ username: 'alice' })
		const clerk = makeClerkClient({ clerkUser })
		mockCreateClerkClient.mockReturnValue(clerk as any)
		mockGetCookie.mockReturnValue(undefined)
		mockFindUnique.mockResolvedValueOnce(null)

		const dbError = new Error('Connection refused')
		mockUpsert.mockRejectedValueOnce(dbError)

		await expect(syncUser()).rejects.toThrow('Connection refused')
	})
})
