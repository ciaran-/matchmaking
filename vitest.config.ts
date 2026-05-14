import { defineConfig } from 'vitest/config'
import { resolve } from 'node:path'

export default defineConfig({
	test: {
		exclude: ['**/node_modules/**', '**/.claude/**', 'src/**/*.integration.test.ts'],
	},
	resolve: {
		alias: {
			'@': resolve(import.meta.dirname, './src'),
		},
	},
})
