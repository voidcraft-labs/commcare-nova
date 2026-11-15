// The signed-in member's session, resolved as the page loads, for a peer
// that runs Preview's form engine but no auth server. Preview opens a form
// only once the member's session has resolved, since a session with no
// worker holds none of the worker's keys (`identity.ts::awaitsPreviewIdentity`).
export function useAuth() {
	return {
		user: {
			id: "native-worker",
			name: "Native worker",
			email: "native@example.org",
		},
		isAuthenticated: true,
		isPending: false,
		signIn: async () => undefined,
	};
}
