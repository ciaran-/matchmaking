import { Show, SignInButton, UserButton } from '@clerk/react';

export default function HeaderUser() {
	return (
		<>
			<Show when="signed-in">
				<UserButton />
			</Show>
			<Show when="signed-out">
				<SignInButton />
			</Show>
		</>
	);
}
