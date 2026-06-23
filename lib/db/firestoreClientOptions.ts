/**
 * Transport/settings options shared by the Firestore clients this code owns —
 * the two prod singletons (`getDb` in lib/db/firestore.ts, `getAuthDb` in
 * lib/auth.ts), the CI auth healthz (scripts/ci/auth-healthz.ts), and the
 * session-cookie contract test — so the emulator transport decision is made in
 * one place. (The older emulator-gated integration tests still construct their
 * own clients; routing them through here too is a worthwhile follow-up.)
 *
 * A dependency-free leaf (only reads `process.env`) on purpose: lib/auth.ts and
 * the CI script can pull it without dragging in the Firestore converter graph.
 *
 * `preferRest` is `true` against real Firestore for two reasons:
 *   1. Build safety — gRPC channel establishment hangs indefinitely when
 *      credentials aren't available (e.g. Docker build with no ADC/metadata
 *      server); REST fails fast with an HTTP error a caller's try/catch handles.
 *   2. Serverless fit — Cloud Run scales to zero; REST is stateless and avoids
 *      re-establishing a persistent channel on every cold start. Recommended by
 *      Google for serverless.
 *
 * EXCEPT against the emulator: the REST transport still calls
 * `GoogleAuth.getClient()`, which needs ADC even though the emulator validates
 * nothing — so a credential-free environment (CI smoke) fails to load default
 * credentials. gRPC connects to the emulator over an insecure channel with no
 * auth at all. Prod never sets `FIRESTORE_EMULATOR_HOST`, so production keeps
 * REST unchanged.
 */
export function firestoreClientOptions(): {
	ignoreUndefinedProperties: true;
	preferRest: boolean;
} {
	return {
		ignoreUndefinedProperties: true,
		preferRest: !process.env.FIRESTORE_EMULATOR_HOST,
	};
}
