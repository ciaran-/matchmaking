// @vitest-environment jsdom

import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

// Mock Clerk's exports so the gate can be tested without Clerk's
// React context, network calls, or render machinery.
vi.mock('@clerk/clerk-react', () => ({
	useUser: vi.fn(),
	SignIn: () => <div data-testid="mock-clerk-signin">[Clerk SignIn]</div>,
}));

import { useUser } from '@clerk/clerk-react';
import { SignInGate } from './SignInGate';

const useUserMock = vi.mocked(useUser);

// vitest does not auto-clean the jsdom DOM between tests; without
// this, mounted output from earlier tests leaks into later assertions
// (specifically `queryByTestId` for absence checks).
afterEach(cleanup);

describe('SignInGate', () => {
	it('shows a loading spinner while Clerk is still booting', () => {
		useUserMock.mockReturnValue({
			isLoaded: false,
			isSignedIn: false,
		} as never);
		const { container } = render(
			<SignInGate>
				<div data-testid="children">protected</div>
			</SignInGate>,
		);

		expect(container.querySelector('.animate-spin')).not.toBeNull();
		expect(screen.queryByTestId('mock-clerk-signin')).toBeNull();
		expect(screen.queryByTestId('children')).toBeNull();
	});

	it('shows the Clerk sign-in form when signed out', () => {
		useUserMock.mockReturnValue({
			isLoaded: true,
			isSignedIn: false,
		} as never);
		render(
			<SignInGate>
				<div data-testid="children">protected</div>
			</SignInGate>,
		);

		expect(screen.getByTestId('mock-clerk-signin')).toBeDefined();
		expect(screen.queryByTestId('children')).toBeNull();
	});

	it('renders children when signed in', () => {
		useUserMock.mockReturnValue({
			isLoaded: true,
			isSignedIn: true,
		} as never);
		render(
			<SignInGate>
				<div data-testid="children">protected</div>
			</SignInGate>,
		);

		expect(screen.getByTestId('children')).toBeDefined();
		expect(screen.queryByTestId('mock-clerk-signin')).toBeNull();
	});
});
