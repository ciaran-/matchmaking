// @vitest-environment node

import type { User } from '@prisma/client';
import { describe, expect, it } from 'vitest';
import {
	canActOnGame,
	canActOnMatch,
	isElevated,
	isParticipant,
} from './authorization';

function user(id: string, role: 'PLAYER' | 'ADMIN' = 'PLAYER'): User {
	return { id, role } as User;
}

const sides = { playerAId: 'alice', playerBId: 'bob' };

describe('isParticipant', () => {
	it('is true for either side of the game', () => {
		expect(isParticipant(user('alice'), sides)).toBe(true);
		expect(isParticipant(user('bob'), sides)).toBe(true);
	});

	it('is false for a bystander', () => {
		expect(isParticipant(user('carol'), sides)).toBe(false);
	});
});

describe('isElevated', () => {
	it('is true only for ADMIN', () => {
		expect(isElevated(user('carol', 'ADMIN'))).toBe(true);
		expect(isElevated(user('carol'))).toBe(false);
	});
});

describe('canActOnGame', () => {
	it('allows the players', () => {
		expect(canActOnGame(user('alice'), sides)).toBe(true);
		expect(canActOnGame(user('bob'), sides)).toBe(true);
	});

	it('refuses an unrelated player', () => {
		expect(canActOnGame(user('carol'), sides)).toBe(false);
	});

	it('allows an admin who is not playing', () => {
		expect(canActOnGame(user('carol', 'ADMIN'), sides)).toBe(true);
	});

	it('does not depend on role for participants', () => {
		// A participant is allowed regardless of role — the common path
		// must never require a role lookup to succeed.
		expect(canActOnGame(user('alice'), sides)).toBe(true);
	});
});

describe('canActOnMatch', () => {
	const match = {
		playerAId: 'alice',
		playerBId: 'bob',
	};

	it('applies the same rule to a derived match', () => {
		expect(canActOnMatch(user('alice'), match)).toBe(true);
		expect(canActOnMatch(user('carol'), match)).toBe(false);
		expect(canActOnMatch(user('carol', 'ADMIN'), match)).toBe(true);
	});
});
