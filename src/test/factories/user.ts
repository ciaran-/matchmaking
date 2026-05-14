import type { PrismaClient, User } from '@prisma/client';

let counter = 0;

interface UserOverrides {
	clerkId?: string | null;
	email?: string;
	username?: string;
	currentRating?: number;
}

export async function createUser(
	prisma: PrismaClient,
	overrides: UserOverrides = {},
): Promise<User> {
	counter++;
	return prisma.user.create({
		data: {
			clerkId: overrides.clerkId !== undefined ? overrides.clerkId : null,
			email: overrides.email ?? `testuser${counter}@test.local`,
			username: overrides.username ?? `testuser${counter}`,
			currentRating: overrides.currentRating ?? 1000,
		},
	});
}
