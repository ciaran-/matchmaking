import { createFileRoute } from '@tanstack/react-router';
import { jsonOk } from '@/lib/api/respond';

// Throwaway reference route proving the server-route mechanism end-to-end
// (T1). T6 replaces it with the first real endpoint and deletes this file.
export const Route = createFileRoute('/api/v1/ping')({
	server: {
		handlers: {
			GET: () => jsonOk({ ok: true }),
		},
	},
});
