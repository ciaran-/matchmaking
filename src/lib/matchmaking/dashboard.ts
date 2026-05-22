// Server-only module — do not import from client-side code.

import { prisma } from '@/db';
import {
	type DbClient,
	getActiveMatches,
	getActiveSearches,
} from '@/lib/matchmaking/state';

export const RATING_BUCKET_SIZE = 25;

export interface LeagueActivityBucket {
	rating: number;
	searching: number;
	awaitingConfirmation: number;
	playing: number;
}

export interface LeagueActivityBundle {
	buckets: LeagueActivityBucket[];
	recentResults: { last5Min: number; lastHour: number; last24h: number };
	generatedAt: string;
}

export function ratingBucket(rating: number): number {
	return Math.floor(rating / RATING_BUCKET_SIZE) * RATING_BUCKET_SIZE;
}

type BucketKey = 'searching' | 'awaitingConfirmation' | 'playing';

/**
 * Aggregates league-wide activity into an anonymised bundle for the
 * dashboard panel: rating-bucketed counts of who is searching, awaiting
 * confirmation, or playing, plus rolling counts of recently-played games.
 *
 * The output contains only counts and bucket lower-bounds — no user,
 * match, attempt, or game identifiers. See the anonymisation contract
 * test for the enforced denylist.
 */
export async function getLeagueActivity(
	client: DbClient = prisma,
): Promise<LeagueActivityBundle> {
	const now = new Date();
	const fiveMinAgo = new Date(now.getTime() - 5 * 60 * 1000);
	const oneHourAgo = new Date(now.getTime() - 60 * 60 * 1000);
	const oneDayAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000);

	const [searches, matches, last5Min, lastHour, last24h] = await Promise.all([
		getActiveSearches(client),
		getActiveMatches(client),
		client.gameResult.count({ where: { createdAt: { gte: fiveMinAgo } } }),
		client.gameResult.count({ where: { createdAt: { gte: oneHourAgo } } }),
		client.gameResult.count({ where: { createdAt: { gte: oneDayAgo } } }),
	]);

	const buckets = new Map<number, LeagueActivityBucket>();
	const bump = (rating: number, key: BucketKey): void => {
		const b = ratingBucket(rating);
		const existing = buckets.get(b) ?? {
			rating: b,
			searching: 0,
			awaitingConfirmation: 0,
			playing: 0,
		};
		existing[key]++;
		buckets.set(b, existing);
	};

	searches.forEach((s) => {
		bump(s.rating, 'searching');
	});
	matches.forEach((m) => {
		// BOTH_CONFIRMED → playing; PROPOSED / CONFIRMED_BY → awaiting.
		// Terminal states are filtered out upstream by getActiveMatches.
		const key: BucketKey =
			m.status === 'BOTH_CONFIRMED' ? 'playing' : 'awaitingConfirmation';
		bump(m.playerARating, key);
		bump(m.playerBRating, key);
	});

	return {
		buckets: [...buckets.values()].sort((a, b) => a.rating - b.rating),
		recentResults: { last5Min, lastHour, last24h },
		generatedAt: now.toISOString(),
	};
}
