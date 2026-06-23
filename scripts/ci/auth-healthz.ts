/**
 * CI auth-boundary healthz — the faithful pre-merge gate for the dependency /
 * runtime regressions that have taken prod login down (#143 undici, #145
 * firebase-admin node-fetch v2).
 *
 * Why this exists separately from the Playwright smoke: the smoke points the app
 * at a Firestore EMULATOR, which talks plain HTTP to localhost and skips the
 * Google token fetch + metadata server — i.e. it stubs out the exact outbound
 * network layer that broke. So the emulator can't catch this class. This gate
 * does what prod does: a REAL firebase-admin → REAL Firestore round-trip over
 * the real outbound HTTP stack, on the exact Node patch prod ships.
 *
 * It reproduces the broken primitive — the firebase-admin Firestore client
 * built with the SAME options as `lib/auth.ts::getAuthDb` (via the shared
 * `firestoreClientOptions`, so a future change to that construction is exercised
 * here too) — doing create → read → delete. Two outbound surfaces get
 * exercised, both of which the regressions broke:
 *   • credential acquisition (google-auth-library / gaxios → undici): in CI
 *     this is the WIF token exchange + SA impersonation; on Cloud Run it was
 *     the metadata server + oauth2.googleapis.com — the same stack.
 *   • the Firestore data call (google-gax / node-fetch).
 * If either regresses, the round-trip throws (classically
 * ERR_STREAM_PREMATURE_CLOSE) and this exits non-zero, turning the PR red.
 *
 * Run by the `auth-healthz` CI job against the isolated `commcare-nova-ci`
 * project (its own empty Firestore — no real data anywhere) via keyless WIF.
 * REFUSES to run against the emulator — the whole point is the real network.
 */
import { randomUUID } from "node:crypto";
import { writeSync } from "node:fs";
import { Firestore } from "firebase-admin/firestore";
import { firestoreClientOptions } from "@/lib/db/firestoreClientOptions";

const COLLECTION = "ci_healthz";
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
	// Hard guard: this gate is meaningless against the emulator (which stubs out
	// the outbound stack that broke prod). Refuse so a misconfigured run fails
	// loud instead of testing nothing.
	if (process.env.FIRESTORE_EMULATOR_HOST) {
		throw new Error(
			"FIRESTORE_EMULATOR_HOST is set — this gate must hit REAL Firestore to exercise the outbound stack that broke prod. Unset it.",
		);
	}
	const projectId = process.env.GOOGLE_CLOUD_PROJECT;
	if (!projectId) {
		throw new Error(
			"GOOGLE_CLOUD_PROJECT is required (the project the CI service account targets — the isolated commcare-nova-ci project).",
		);
	}

	// Same options as lib/auth.ts::getAuthDb (REST here — the guard above ensures
	// no emulator). ADC comes from google-github-actions/auth (WIF) in CI, or
	// `gcloud auth application-default login` locally.
	const db = new Firestore({ projectId, ...firestoreClientOptions() });
	const ref = db.collection(COLLECTION).doc(`ci-${randomUUID()}`);
	const marker = randomUUID();

	try {
		await ref.set({ marker, at: new Date(), runner: "ci-auth-healthz" });
		const snap = await ref.get();
		if (!snap.exists || snap.get("marker") !== marker) {
			throw new Error(
				`round-trip mismatch — wrote ${marker}, read back ${snap.get("marker") ?? "<missing>"}`,
			);
		}
		console.log(
			`[auth-healthz] OK — firebase-admin ⇄ ${projectId} Firestore round-trip succeeded on Node ${process.version}.`,
		);
	} finally {
		await ref.delete().catch(() => {});
		await db.terminate().catch(() => {});
	}
}

// Hard timeout: a broken keep-alive can hang rather than throw — don't let CI
// sit. unref() so it never keeps the process alive on the happy path.
const timer = setTimeout(() => {
	logFailure(
		`timed out after ${TIMEOUT_MS}ms — the outbound Firestore call hung (a keep-alive / undici regression signature).`,
	);
	process.exit(1);
}, TIMEOUT_MS);
timer.unref();

main()
	.then(() => clearTimeout(timer))
	.catch((err) => {
		clearTimeout(timer);
		// Set the exit code and let the event loop drain (the client is already
		// terminated in `finally`) rather than process.exit() — the synchronous
		// logFailure above has already flushed the diagnostic.
		logFailure(
			"firebase-admin Firestore round-trip threw — the auth outbound stack is broken (this is how prod login outages look).",
			err,
		);
		process.exitCode = 1;
	});
