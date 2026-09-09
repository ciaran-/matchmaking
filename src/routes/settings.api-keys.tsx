import * as Sentry from '@sentry/tanstackstart-react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { createFileRoute } from '@tanstack/react-router';
import { createServerFn } from '@tanstack/react-start';
import { useId, useState } from 'react';
import { SignInGate } from '@/components/SignInGate';
import { Button } from '@/components/storybook/button';
import { issueApiKey, listApiKeys, revokeApiKey } from '@/lib/api-keys';
import { authenticatedUser } from '@/lib/auth';
import { userFacingError } from '@/lib/user-facing-errors';

/** Longest key name we accept. Clerk has no documented limit; this is ours. */
const MAX_NAME_LENGTH = 64;

// All three use POST: each performs a Clerk auth check, so none of them
// are safe to expose to router preloading (see CLAUDE.md).

export const listApiKeysFn = createServerFn({ method: 'POST' }).handler(
	async () => {
		return Sentry.startSpan({ name: 'API keys: list' }, async () => {
			const user = await authenticatedUser();
			return listApiKeys(user.clerkId);
		});
	},
);

export const issueApiKeyFn = createServerFn({ method: 'POST' })
	.inputValidator((data: { name: string }) => data)
	.handler(async ({ data }) => {
		return Sentry.startSpan({ name: 'API keys: issue' }, async () => {
			const name = data.name.trim();
			if (!name) throw new Error('A key name is required.');
			if (name.length > MAX_NAME_LENGTH) {
				throw new Error('That key name is too long.');
			}

			const user = await authenticatedUser();
			return issueApiKey(user.clerkId, name);
		});
	});

export const revokeApiKeyFn = createServerFn({ method: 'POST' })
	.inputValidator((data: { keyId: string }) => data)
	.handler(async ({ data }) => {
		return Sentry.startSpan({ name: 'API keys: revoke' }, async () => {
			const user = await authenticatedUser();
			// Ownership is enforced in `revokeApiKey` against the key's
			// Clerk subject — a key id from the client is never trusted.
			return revokeApiKey(user.clerkId, data.keyId);
		});
	});

export const Route = createFileRoute('/settings/api-keys')({
	ssr: 'data-only',
	component: ApiKeysSettings,
});

function formatDate(epochMs: number | null): string {
	if (!epochMs) return 'Never';
	return new Date(epochMs).toLocaleDateString(undefined, {
		year: 'numeric',
		month: 'short',
		day: 'numeric',
	});
}

function ApiKeysSettings() {
	return (
		<div className="min-h-screen bg-gradient-to-b from-slate-900 via-slate-800 to-slate-900">
			<section className="py-16 px-6 max-w-3xl mx-auto">
				<h1 className="text-4xl font-black text-white mb-2">API keys</h1>
				<p className="text-slate-400 mb-10">
					Personal keys let scripts and other non-browser clients call the API
					as you. Send one as{' '}
					<code className="text-cyan-300">
						Authorization: Bearer &lt;key&gt;
					</code>
					. Revoking a key takes up to a minute to take effect, so treat a
					leaked key as live until then.
				</p>
				<SignInGate>
					<ApiKeyManager />
				</SignInGate>
			</section>
		</div>
	);
}

function ApiKeyManager() {
	const queryClient = useQueryClient();
	const nameInputId = useId();

	const [name, setName] = useState('');
	const [freshKey, setFreshKey] = useState<string | null>(null);
	const [copied, setCopied] = useState(false);
	const [confirmingRevokeId, setConfirmingRevokeId] = useState<string | null>(
		null,
	);
	const [error, setError] = useState<string | null>(null);

	const keysQuery = useQuery({
		queryKey: ['apiKeys'],
		queryFn: () => listApiKeysFn(),
	});

	const refresh = () => {
		queryClient.invalidateQueries({ queryKey: ['apiKeys'] });
	};

	const issueMutation = useMutation({
		mutationFn: (keyName: string) => issueApiKeyFn({ data: { name: keyName } }),
		onSuccess: ({ raw }) => {
			// The only moment this value exists in the app. Held in component
			// state so it disappears on navigation, and never refetched.
			setFreshKey(raw);
			setCopied(false);
			setName('');
			setError(null);
			refresh();
		},
		onError: (e) => setError(userFacingError(e, "Couldn't create that key.")),
	});

	const revokeMutation = useMutation({
		mutationFn: (keyId: string) => revokeApiKeyFn({ data: { keyId } }),
		onSuccess: () => {
			setConfirmingRevokeId(null);
			setError(null);
			refresh();
		},
		onError: (e) => setError(userFacingError(e, "Couldn't revoke that key.")),
	});

	const copyFreshKey = async () => {
		if (!freshKey || !navigator.clipboard) return;
		await navigator.clipboard.writeText(freshKey);
		setCopied(true);
	};

	const keys = keysQuery.data ?? [];

	return (
		<div className="flex flex-col gap-8">
			{freshKey && (
				<div className="rounded-xl border border-cyan-500/50 bg-cyan-500/10 p-5">
					<p className="text-cyan-200 font-semibold mb-1">
						Copy this key now — you won't be able to see it again.
					</p>
					<p className="text-slate-400 text-sm mb-4">
						We don't store the key itself, so there is no way to show it to you
						a second time. If you lose it, revoke it and create another.
					</p>
					<div className="flex items-center gap-3">
						<code className="flex-1 break-all bg-slate-900 text-cyan-300 rounded-lg px-3 py-2 text-sm">
							{freshKey}
						</code>
						<Button variant="secondary" size="small" onClick={copyFreshKey}>
							{copied ? 'Copied' : 'Copy'}
						</Button>
					</div>
					<button
						type="button"
						onClick={() => setFreshKey(null)}
						className="mt-4 text-slate-400 hover:text-slate-200 text-sm underline"
					>
						I've saved it — hide this
					</button>
				</div>
			)}

			{error && (
				<p className="rounded-lg bg-red-500/10 border border-red-500/40 text-red-300 px-4 py-3">
					{error}
				</p>
			)}

			<div className="rounded-xl border border-slate-700 bg-slate-800/60 p-5">
				<label
					htmlFor={nameInputId}
					className="block text-slate-300 font-medium mb-2"
				>
					Create a key
				</label>
				<div className="flex gap-3">
					<input
						id={nameInputId}
						value={name}
						maxLength={MAX_NAME_LENGTH}
						onChange={(e) => setName(e.target.value)}
						placeholder="What's it for? e.g. Deploy script"
						className="flex-1 bg-slate-700 border border-slate-500 text-white placeholder:text-slate-400 rounded-lg px-3 py-2"
					/>
					<Button
						onClick={() => issueMutation.mutate(name)}
						disabled={!name.trim() || issueMutation.isPending}
					>
						{issueMutation.isPending ? 'Creating…' : 'Create'}
					</Button>
				</div>
			</div>

			<div className="flex flex-col gap-3">
				{keysQuery.isPending && <p className="text-slate-400">Loading keys…</p>}

				{keysQuery.isError && (
					<p className="text-red-300">
						{userFacingError(keysQuery.error, "Couldn't load your keys.")}
					</p>
				)}

				{keysQuery.isSuccess && keys.length === 0 && (
					<p className="text-slate-400">You haven't created any keys yet.</p>
				)}

				{keys.map((key) => (
					<div
						key={key.id}
						className="flex items-center justify-between gap-4 rounded-xl border border-slate-700 bg-slate-800/60 px-5 py-4"
					>
						<div>
							<p
								className={`font-semibold ${
									key.revoked ? 'text-slate-500 line-through' : 'text-white'
								}`}
							>
								{key.name}
							</p>
							<p className="text-slate-400 text-sm">
								Created {formatDate(key.createdAt)} · Last used{' '}
								{formatDate(key.lastUsedAt)}
							</p>
						</div>

						{key.revoked ? (
							<span className="text-slate-500 text-sm">Revoked</span>
						) : confirmingRevokeId === key.id ? (
							<div className="flex items-center gap-2">
								<span className="text-slate-300 text-sm">
									Revoke it? It may keep working for up to a minute.
								</span>
								<Button
									variant="danger"
									size="small"
									disabled={revokeMutation.isPending}
									onClick={() => revokeMutation.mutate(key.id)}
								>
									Yes, revoke
								</Button>
								<Button
									variant="secondary"
									size="small"
									onClick={() => setConfirmingRevokeId(null)}
								>
									Cancel
								</Button>
							</div>
						) : (
							<Button
								variant="secondary"
								size="small"
								onClick={() => setConfirmingRevokeId(key.id)}
							>
								Revoke
							</Button>
						)}
					</div>
				))}
			</div>
		</div>
	);
}
