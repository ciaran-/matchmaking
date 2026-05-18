import type { Config } from '@netlify/functions';

export default async () => {
	const { runMatcherPass } = await import(
		'../../src/lib/matchmaking/run-matcher'
	);
	const result = await runMatcherPass();
	return new Response(JSON.stringify(result), {
		status: 200,
		headers: { 'content-type': 'application/json' },
	});
};

export const config: Config = {
	schedule: '@every 1m',
};
