// The signed-in member of `preview-refusal-backstop.spec.ts`'s peer. Better
// Auth's session atom hands every render the same user until the session is
// fetched again, so the member here is one object too: the refusal backstop
// tries its screen again when the worker changes, and a user minted on every
// render would retry it on every render, hiding what else retries it.

const user = {
	id: "native-worker",
	name: "Native worker",
	email: "native@example.org",
};

const auth = {
	user,
	isAuthenticated: true,
	isPending: false,
	signIn: async () => undefined,
};

export function useAuth() {
	return auth;
}
