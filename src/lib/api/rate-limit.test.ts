// @vitest-environment node

import { describe, expect, it } from 'vitest';
import {
	consumeRateLimit,
	InMemoryRateLimitStore,
	RATE_LIMIT,
	RATE_LIMIT_WINDOW_MS,
	rateLimitKey,
} from './rate-limit';

const T0 = 1_700_000_000_000;

describe('consumeRateLimit', () => {
	it('allows the first request and reports the remaining budget', () => {
		const store = new InMemoryRateLimitStore();

		const decision = consumeRateLimit(store, 'key', T0);

		expect(decision.allowed).toBe(true);
		expect(decision.remaining).toBe(RATE_LIMIT - 1);
	});

	it('allows exactly RATE_LIMIT requests in a window, then blocks', () => {
		const store = new InMemoryRateLimitStore();

		for (let i = 0; i < RATE_LIMIT; i++) {
			expect(consumeRateLimit(store, 'key', T0).allowed).toBe(true);
		}

		const blocked = consumeRateLimit(store, 'key', T0);
		expect(blocked.allowed).toBe(false);
		expect(blocked.remaining).toBe(0);
	});

	it('reports seconds until the window resets, never zero', () => {
		const store = new InMemoryRateLimitStore();
		for (let i = 0; i <= RATE_LIMIT; i++) consumeRateLimit(store, 'key', T0);

		// 1ms before the window ends: a Retry-After of 0 would invite an
		// immediate retry that is still blocked.
		const decision = consumeRateLimit(
			store,
			'key',
			T0 + RATE_LIMIT_WINDOW_MS - 1,
		);

		expect(decision.allowed).toBe(false);
		expect(decision.retryAfterSeconds).toBeGreaterThanOrEqual(1);
	});

	it('starts a fresh window once the old one passes', () => {
		const store = new InMemoryRateLimitStore();
		for (let i = 0; i <= RATE_LIMIT; i++) consumeRateLimit(store, 'key', T0);

		const after = consumeRateLimit(store, 'key', T0 + RATE_LIMIT_WINDOW_MS);

		expect(after.allowed).toBe(true);
		expect(after.remaining).toBe(RATE_LIMIT - 1);
	});

	it('buckets credentials independently', () => {
		const store = new InMemoryRateLimitStore();
		for (let i = 0; i <= RATE_LIMIT; i++) consumeRateLimit(store, 'noisy', T0);

		expect(consumeRateLimit(store, 'quiet', T0).allowed).toBe(true);
	});
});

describe('InMemoryRateLimitStore', () => {
	it('does not grow without bound as credentials churn', () => {
		const store = new InMemoryRateLimitStore(10);

		// Far more distinct keys than the cap, spread across windows.
		for (let i = 0; i < 100; i++) {
			consumeRateLimit(store, `key-${i}`, T0 + i);
		}

		expect(store.size).toBeLessThanOrEqual(10);
	});

	it('evicts windows that have already passed', () => {
		const store = new InMemoryRateLimitStore(10);
		for (let i = 0; i < 10; i++) consumeRateLimit(store, `old-${i}`, T0);

		consumeRateLimit(store, 'new', T0 + RATE_LIMIT_WINDOW_MS + 1);

		// The ten expired windows are gone, not merely trimmed by one.
		expect(store.size).toBeLessThan(10);
	});
});

describe('rateLimitKey', () => {
	function req(headers: Record<string, string>) {
		return new Request('https://example.test/api/v1/leaderboard', { headers });
	}

	it('never contains the raw credential', async () => {
		const key = await rateLimitKey(
			req({ authorization: 'Bearer ak_super_secret_value' }),
		);

		expect(key).not.toContain('ak_super_secret_value');
		expect(key).not.toContain('Bearer');
		expect(key).toMatch(/^[0-9a-f]{32}$/);
	});

	it('is stable for the same credential', async () => {
		const headers = { authorization: 'Bearer ak_one' };

		expect(await rateLimitKey(req(headers))).toBe(
			await rateLimitKey(req(headers)),
		);
	});

	it('differs between credentials', async () => {
		expect(
			await rateLimitKey(req({ authorization: 'Bearer ak_one' })),
		).not.toBe(await rateLimitKey(req({ authorization: 'Bearer ak_two' })));
	});

	it('falls back to the session cookie when there is no auth header', async () => {
		const key = await rateLimitKey(req({ cookie: '__session=jwt_value' }));

		expect(key).not.toContain('jwt_value');
		expect(key).not.toBe('anonymous');
	});

	it('buckets credential-less requests together', async () => {
		expect(await rateLimitKey(req({}))).toBe('anonymous');
	});
});
