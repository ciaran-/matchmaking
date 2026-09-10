// Server-only module — do not import from client-side code.

import type { DerivedMatchState } from '@/lib/matchmaking/state';

/**
 * Wire-safe shape of `DerivedMatchState`.
 *
 * `jsonOk` serialises via `Response.json` → `JSON.stringify`, which turns
 * a `Set` into `{}` (it has no enumerable own properties) — silently
 * dropping `confirmedBy`. That's the one field on `DerivedMatchState` /
 * `DerivedSearchState` that doesn't round-trip through `JSON.stringify`
 * unchanged (`Date` fields already serialise to ISO strings on their
 * own), so it's the only translation the matchmaking-lifecycle endpoints
 * need before handing a derived state to `jsonOk`.
 */
export type SerializedMatchState = Omit<DerivedMatchState, 'confirmedBy'> & {
	confirmedBy: string[];
};

export function serializeMatchState(
	match: DerivedMatchState,
): SerializedMatchState {
	return { ...match, confirmedBy: [...match.confirmedBy] };
}
