import { defineConfig } from 'vitest/config'
import { resolve } from 'node:path'

export default defineConfig({
	test: {
		include: ['src/**/*.integration.test.ts'],
		// testcontainers requires real child processes, not worker threads.
		pool: 'forks',
		// Container startup can take ~10–15s on a cold image pull.
		testTimeout: 60_000,
		hookTimeout: 60_000,
	},
	resolve: {
		alias: {
			'@': resolve(import.meta.dirname, './src'),
		},
	},
})
