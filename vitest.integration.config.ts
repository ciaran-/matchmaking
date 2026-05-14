import { defineConfig } from 'vitest/config'
import { resolve } from 'node:path'

export default defineConfig({
	test: {
		include: ['src/**/*.integration.test.ts'],
		// testcontainers requires real child processes, not worker threads.
		pool: 'forks',
		// Container startup: ~2s warm cache, up to ~120s on first cold pull.
		testTimeout: 60_000,
		hookTimeout: 120_000,
	},
	resolve: {
		alias: {
			'@': resolve(import.meta.dirname, './src'),
		},
	},
})
