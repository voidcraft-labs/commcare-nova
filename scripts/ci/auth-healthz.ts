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
 * all over that HTTP stack) on the exact Node patch prod ships. A regression in
 * the stack (a Node/undici/node-fetch bump that breaks keep-alive, an
 * ERR_STREAM_PREMATURE_CLOSE) throws or hangs here and reds the PR — before it
 * can merge. The emulator-backed Playwright smoke can't catch this class: it
 * replaces that exact network layer.
 *
 * It uses `google-auth-library` directly — the SAME library the connector
 * depends on (npm dedupes them to one copy) — rather than a Firestore round-trip,
 * so the test exercises the auth path's real credential stack with no database
 * in the picture. The faithfulness holds while the connector and firebase-admin
 * resolve the same `google-auth-library`/`gaxios`; the Firestore app-data path
 * keeps its own gate in `scripts/ci/firestore-healthz.ts`.
 *
 * What it deliberately does NOT cover: the connector's OWN code — the Cloud SQL
 * Admin-API cert mint and the mTLS socket to the instance. That can only run
 * against a real Cloud SQL instance (no emulator, no offline mode exists), it
 * has never been the outage class, and its failure modes (cert expiry/refresh)
 * are runtime behaviour a one-shot CI check can't reproduce. The pg driver +
 * Better Auth adapter are covered pre-merge by the testcontainer auth-contract
 * job; the connector's live path is exercised post-merge by the migrate Job
 * before traffic shifts.
 *
 * Run by the `auth-healthz` CI job against the isolated `commcare-nova-ci`
 * project via keyless WIF.
 */
import { writeSync } from "node:fs";
import { GoogleAuth } from "google-auth-library";

// Mirror the scope the Cloud SQL connector requests for its Admin-API calls so
// the minted token shapes the same credential path. The token is never used
// against a resource — minting it is what exercises the outbound stack.
const SCOPE = "https://www.googleapis.com/auth/sqlservice.admin";
const TIMEOUT_MS = 30_000;

/**
 * Write the failure diagnostic to stderr SYNCHRONOUSLY. The whole point of this
 * gate is surfacing the regression signature (e.g. an ERR_STREAM_PREMATURE_CLOSE
 * stack); on CI's piped stderr a `console.error` + `process.exit()` can drop the
 * buffered write, so use `writeSync` which is flushed before control returns.
 */
function logFailure(msg: string, err?: unknown): void {
	writeSync(2, `[auth-healthz] FAIL: ${msg}\n`);
	if (err !== undefined) {
		writeSync(
			2,
			`${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`,
		);
	}
}

async function main(): Promise<void> {
	// ADC comes from google-github-actions/auth (WIF) in CI, or
	// `gcloud auth application-default login` locally. No emulator branch — this
	// gate is meaningless without the real outbound network. Under WIF this does
	// the STS token exchange + SA impersonation, two sequential HTTPS calls over
	// the same gaxios/node-fetch agent the connector uses.
	const auth = new GoogleAuth({ scopes: [SCOPE] });
	const token = await auth.getAccessToken();
	if (!token) {
		throw new Error(
			"getAccessToken returned no token — ADC loaded but the token mint produced nothing.",
		);
	}
	console.log(
		`[auth-healthz] OK — google-auth-library minted an access token over the prod outbound stack on Node ${process.version}.`,
	);
}

// Hard timeout: a broken keep-alive can hang rather than throw — don't let CI
// sit. unref() so it never keeps the process alive on the happy path.
const timer = setTimeout(() => {
	logFailure(
		`timed out after ${TIMEOUT_MS}ms — the outbound token mint hung (a keep-alive / undici regression signature).`,
	);
	process.exit(1);
}, TIMEOUT_MS);
timer.unref();

main()
	.then(() => {
		clearTimeout(timer);
		// Force-exit rather than relying on natural drain: this gate deliberately
		// exercises the WIF/gaxios keep-alive HTTP stack, and a lingering keep-alive
		// socket (the exact layer being tested) could keep the loop alive past
		// main() with the watchdog already cleared. Matches e2e/seed.ts's exit.
		process.exit(0);
	})
	.catch((err) => {
		clearTimeout(timer);
		// logFailure used writeSync (flushed synchronously), so process.exit(1)
		// can't truncate the diagnostic.
		logFailure(
			"google-auth-library token mint threw — the auth outbound credential stack is broken (this is how prod login outages look).",
			err,
		);
		process.exit(1);
	});
