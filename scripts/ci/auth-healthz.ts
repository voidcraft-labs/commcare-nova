/**
 * CI Google-credential outbound healthz — the faithful pre-merge gate for the
 * dependency / runtime regressions that have taken prod auth down (#143 undici,
 * #145 node-fetch v2 keep-alive, the Node base-tag bump).
 *
 * After the Postgres cutover, login runs through the Cloud SQL connector
 * (`@google-cloud/cloud-sql-connector`), which mints its ephemeral client cert +
 * IAM token through `google-auth-library` → `gaxios` → `node-fetch` — the same
 * outbound credential stack every prior auth outage lived in. This gate
 * exercises THAT stack directly: it mints a real access token via the CI service
 * account (Workload Identity Federation → STS token exchange → SA impersonation,
 * two sequential HTTPS calls over that stack) on the exact Node patch prod ships.
 * A regression in the stack (a Node/undici/node-fetch bump that breaks
 * keep-alive, an ERR_STREAM_PREMATURE_CLOSE) throws or hangs here and reds the PR
 * — before it can merge. The emulator-backed Playwright smoke can't catch this
 * class: it replaces that exact network layer.
 *
 * `google-auth-library` is declared as a devDependency at the connector's own
 * range (`^10.6.2`), so npm dedupes it to the SINGLE shared copy the connector +
 * firebase-admin already use — the test exercises the exact library the connector
 * depends on. Keep this range in lockstep with the connector's: nothing enforces
 * it automatically, and a divergent range would split off a second copy this test
 * no longer shares. The Firestore app-data path keeps its own gate in
 * `scripts/ci/firestore-healthz.ts`.
 *
 * What it deliberately does NOT cover: the connector's OWN code — the Cloud SQL
 * Admin-API cert mint and the mTLS socket to the instance. That can only run
 * against a real Cloud SQL instance (no emulator, no offline mode exists), it has
 * never been the outage class, and its failure modes (cert expiry/refresh) are
 * runtime behaviour a one-shot CI check can't reproduce. The pg driver + Better
 * Auth adapter are covered pre-merge by the testcontainer auth-contract job; the
 * connector's live path is exercised post-merge by the migrate Job before traffic
 * shifts.
 *
 * Run by the `auth-healthz` CI job against the isolated `commcare-nova-ci`
 * project via keyless WIF.
 */
import { GoogleAuth } from "google-auth-library";
import { runHealthz } from "./healthz-harness";

// Mirror the scope the Cloud SQL connector requests for its Admin-API calls so
// the minted token shapes the same credential path. The token is never used
// against a resource — minting it is what exercises the outbound stack.
const SCOPE = "https://www.googleapis.com/auth/sqlservice.admin";

// ADC comes from google-github-actions/auth (WIF) in CI, or
// `gcloud auth application-default login` locally. No emulator branch — this gate
// is meaningless without the real outbound network.
runHealthz("auth-healthz", async () => {
	const auth = new GoogleAuth({ scopes: [SCOPE] });
	const token = await auth.getAccessToken();
	if (!token) {
		throw new Error(
			"getAccessToken returned no token — ADC loaded but the token mint produced nothing.",
		);
	}
	return `google-auth-library minted an access token over the prod outbound stack on Node ${process.version}.`;
});
