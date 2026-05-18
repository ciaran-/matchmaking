// @vitest-environment node

import { execSync } from 'node:child_process';
import { PrismaClient } from '@prisma/client';
import { PostgreSqlContainer } from '@testcontainers/postgresql';

export interface TestDatabase {
	prisma: PrismaClient;
	/** Delete all rows in FK-safe order. Call in beforeEach. */
	reset: () => Promise<void>;
	/** Disconnect Prisma and stop the container. Call in afterAll. */
	teardown: () => Promise<void>;
}

export async function createTestDatabase(): Promise<TestDatabase> {
	const container = await new PostgreSqlContainer('postgres:16-alpine').start();
	const url = container.getConnectionUri();

	// Apply all migrations from ./migrations/ against the container.
	// schema.prisma is at the repo root (not ./prisma/schema.prisma).
	execSync('npx prisma migrate deploy --schema=./schema.prisma', {
		env: { ...process.env, DATABASE_URL: url },
		stdio: 'pipe',
	});

	const prisma = new PrismaClient({ datasources: { db: { url } } });

	// Route the @/db singleton proxy to the container client so that lib
	// functions (e.g. recordGame) use the same connection as test assertions.
	globalThis.__prisma = prisma;

	return {
		prisma,
		reset: async () => {
			// Delete children before parents to satisfy FK constraints.
			// MatchmakingSearchEvent has a FK to User, so it must go before User.
			// PendingGameEvent has no FKs (player/match refs are plain strings),
			// but order it alongside the other event log for symmetry.
			await prisma.matchmakingSearchEvent.deleteMany();
			await prisma.pendingGameEvent.deleteMany();
			await prisma.gameParticipant.deleteMany();
			await prisma.gameResult.deleteMany();
			await prisma.user.deleteMany();
		},
		teardown: async () => {
			await prisma.$disconnect();
			await container.stop();
		},
	};
}
