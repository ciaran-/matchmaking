// Server-only module — do not import from client-side code.

import type { User } from '@prisma/client';
import type { DerivedMatchState } from '@/lib/matchmaking/state';

/**
 * Who may act on whose games.
 *
 * Kept as a standalone policy module rather than inline checks in route
 * handlers so there is exactly one place to read, test, and extend when
 * more roles arrive. Both the REST API and the web server functions call
 * these — enforcing in only one would leave the other as an open door.
 *
 * **The rule today:** you may read or act on a game you are playing in.
 * `ADMIN` may act on anyone's.
 *
 * **On future elevated roles.** `User.role` is a *global* grant, which is
 * the right shape for a system administrator and the wrong shape for a
 * tournament organiser, whose authority is bounded by a tournament they
 * own. Do not widen this enum to express scoped authority. When
 * tournaments exist, add a grant table keyed by (user, scope) and have
 * `canActOnGame` consult it alongside the global role — the call sites
 * below should not need to change, which is the point of routing every
 * decision through this module.
 */

/** A participant reference: either side of a game or proposed match. */
export type GameSides = {
	playerAId: string;
	playerBId: string;
};

/** True when the user holds a globally elevating role. */
export function isElevated(user: User): boolean {
	return user.role === 'ADMIN';
}

/** True when the user is one of the two players. */
export function isParticipant(user: User, sides: GameSides): boolean {
	return user.id === sides.playerAId || user.id === sides.playerBId;
}

/**
 * May this user read or act on this game?
 *
 * Participation is checked first because it is the overwhelmingly common
 * case and needs no knowledge of roles at all.
 */
export function canActOnGame(user: User, sides: GameSides): boolean {
	return isParticipant(user, sides) || isElevated(user);
}

/** `canActOnGame` for a derived match, whose sides are named the same. */
export function canActOnMatch(
	user: User,
	match: Pick<DerivedMatchState, 'playerAId' | 'playerBId'>,
): boolean {
	return canActOnGame(user, match);
}
