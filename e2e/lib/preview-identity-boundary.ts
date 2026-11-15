// The identity peer's remote transport: the navigation peer's, with a
// signed-in member's session that has not resolved yet. Better Auth reports
// no user until its session read returns; here that read returns when the
// test says so (`releasePreviewIdentity`), so a test can look at every screen
// while the session is still waiting for its worker.
export * from "./preview-navigation-boundary";

import { useSyncExternalStore } from "react";
import { IDENTITY_WORKER } from "./previewIdentityFixture";

type Worker = typeof IDENTITY_WORKER;

let user: Worker | null = null;
const listeners = new Set<() => void>();

/** The member's session read returns: the worker arrives. */
export function releasePreviewIdentity(): void {
	user = IDENTITY_WORKER;
	for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
	listeners.add(listener);
	return () => {
		listeners.delete(listener);
	};
}

export function useAuth() {
	const current = useSyncExternalStore(
		subscribe,
		() => user,
		() => null,
	);
	return {
		user: current,
		isAuthenticated: current !== null,
		isPending: current === null,
		signIn: async () => undefined,
	};
}
