import { PrismaClient } from '@prisma/client';

declare global {
	var __prisma: PrismaClient | undefined;
}

function getClient(): PrismaClient {
	if (!globalThis.__prisma) {
		globalThis.__prisma = new PrismaClient();
	}
	return globalThis.__prisma;
}

/**
 * Prisma client singleton. Resolved dynamically via globalThis.__prisma so
 * that integration tests can inject a container-backed client by setting
 * globalThis.__prisma before any database call is made.
 */
export const prisma = new Proxy({} as PrismaClient, {
	get(_target, prop) {
		return Reflect.get(getClient(), prop as keyof PrismaClient);
	},
});
