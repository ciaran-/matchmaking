import type { Config } from '@netlify/functions';
import { runMatcherPass } from '../../src/lib/matchmaking/run-matcher';

export default async () => {
	const result = await runMatcherPass();
	return new Response(JSON.stringify(result), {
		status: 200,
		headers: { 'content-type': 'application/json' },
	});
};

export const config: Config = {
	schedule: '@every 1m',
};
