// The signed-in member's session, resolved as the page loads, for a peer
// that runs Preview's form engine but no auth server. Preview opens a form
// only once the member's session has resolved, since a session with no
// worker holds none of the worker's keys (`identity.ts::awaitsPreviewIdentity`).
//
// Better Auth's session atom hands every render the same user until the
// session is fetched again, so the member here is one object too: Preview's
// identity consumers and its refusal backstop (which tries its screen again
// when the worker changes) would otherwise see a new worker on every render,
// hiding what else changes them.

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
