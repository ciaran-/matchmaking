import { SignIn, useUser } from '@clerk/clerk-react';

interface SignInGateProps {
	children: React.ReactNode;
}

// Clerk's <SignIn /> accepts an `appearance` prop that maps element
// keys to className strings. Tailwind utilities push the form toward
// the slate/cyan palette used across the rest of the app. Element
// names follow Clerk's documented `cl-*` class catalogue (minus the
// prefix). Expect to iterate against the live rendered DOM — Clerk
// sometimes ships subtly different element keys between minor
// versions, and a few keys (e.g. social buttons, error states) only
// show up on first paint.
const signInAppearance = {
	elements: {
		rootBox: 'w-full flex justify-center',
		card: 'bg-slate-800/60 border border-slate-700 rounded-xl shadow-lg',
		headerTitle: 'text-slate-100',
		headerSubtitle: 'text-slate-400',
		dividerLine: 'bg-slate-600',
		dividerText: 'text-slate-400',
		formButtonPrimary:
			'bg-gradient-to-r from-cyan-500 to-blue-500 hover:from-cyan-400 hover:to-blue-400 text-white font-semibold rounded-lg shadow-md normal-case',
		formFieldInput:
			'bg-slate-700 border border-slate-500 text-white placeholder:text-slate-400 rounded-lg',
		formFieldLabel: 'text-slate-300',
		formFieldAction: 'text-cyan-400 hover:text-cyan-300',
		identityPreviewText: 'text-slate-200',
		identityPreviewEditButton: 'text-cyan-400 hover:text-cyan-300',
		socialButtonsBlockButton:
			'bg-slate-700 border border-slate-600 text-slate-200 hover:bg-slate-600',
		socialButtonsBlockButtonText: 'text-slate-200',
		footerActionText: 'text-slate-400',
		footerActionLink: 'text-cyan-400 hover:text-cyan-300',
		formFieldErrorText: 'text-red-300',
		alertText: 'text-red-300',
	},
};

/**
 * Gates the rendered children behind Clerk auth.
 *
 * - While Clerk is booting: a centred spinner.
 * - When signed out: a themed embedded `<SignIn />` form (sign-up link
 *   included via Clerk's default footer action).
 * - When signed in: renders `children` unchanged.
 *
 * Use this on routes where the entire content section requires auth.
 * For the marketing homepage (`/`), where the hero should render for
 * everyone, use a styled `<SignInButton>` instead — see
 * `.claude/plans/sign-in-gate-component.md`.
 */
export function SignInGate({ children }: SignInGateProps) {
	const { isLoaded, isSignedIn } = useUser();

	if (!isLoaded) {
		return (
			<div className="flex justify-center py-12">
				<div className="w-10 h-10 rounded-full border-2 border-cyan-400 border-t-transparent animate-spin" />
			</div>
		);
	}

	if (!isSignedIn) {
		return (
			<div className="flex justify-center py-8">
				<SignIn appearance={signInAppearance} />
			</div>
		);
	}

	return <>{children}</>;
}
