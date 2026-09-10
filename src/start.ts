import { createStart } from '@tanstack/react-start';
import { requireAuthenticatedServerFn } from '@/lib/server-fn-auth';

/**
 * Application-wide Start configuration.
 *
 * `functionMiddleware` runs for every server function call, which is what
 * makes their authentication default-deny rather than something each of
 * seventeen handlers has to remember. See `server-fn-auth.ts` — including
 * why this is not `requestMiddleware`.
 */
export const startInstance = createStart(() => ({
	functionMiddleware: [requireAuthenticatedServerFn],
}));
