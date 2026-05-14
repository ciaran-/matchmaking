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

export const prisma = new Proxy({} as PrismaClient, {
	get(_target, prop) {
		const client = getClient();
		const value = Reflect.get(client, prop as keyof PrismaClient);
		return typeof value === 'function'
			? (value as (...args: unknown[]) => unknown).bind(client)
			: value;
	},
});
