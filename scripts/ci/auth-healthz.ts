/**
 * CI auth-boundary healthz — the faithful pre-merge gate for the dependency /
 * runtime regressions that have taken prod login down (#143 undici, #145
 * firebase-admin node-fetch v2).
 *
 * Why this exists separately from the Playwright smoke: the smoke points the app
 * at a Firestore EMULATOR, which talks plain HTTP to localhost and skips the
 * Google token fetch + metadata server — i.e. it stubs out the exact outbound
 * network layer that broke. So the emulator can't catch this class. This gate
 * does what prod does: a REAL firebase-admin → REAL Firestore round-trip, over
 * the real outbound HTTP stack, on the exact Node patch prod ships.
 *
 * It reproduces the broken primitive — the firebase-admin Firestore client
 * constructed exactly like `lib/auth.ts::getAuthDb` (`preferRest`, the path
 * Better Auth's per-request rate limiter uses) — doing create → read → delete.
 * Two outbound surfaces get exercised, both of which the regressions broke:
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
import { Firestore } from "firebase-admin/firestore";

const COLLECTION = "ci_healthz";
const TIMEOUT_MS = 30_000;

function fail(msg: string, err?: unknown): never {
	console.error(`[auth-healthz] FAIL: ${msg}`);
	if (err !== undefined) console.error(err);
	process.exit(1);
}

async function main(): Promise<void> {
	if (process.env.FIRESTORE_EMULATOR_HOST) {
		fail(
			"FIRESTORE_EMULATOR_HOST is set — this gate must hit REAL Firestore to exercise the outbound stack that broke prod. Unset it.",
		);
	}
	const projectId = process.env.GOOGLE_CLOUD_PROJECT;
	if (!projectId) {
		fail(
			"GOOGLE_CLOUD_PROJECT is required (the project the CI service account targets — the dev project).",
		);
	}

	// Same client construction as lib/auth.ts::getAuthDb — the one whose outbound
	// HTTP regressed. ADC comes from google-github-actions/auth (WIF) in CI, or
	// `gcloud auth application-default login` locally.
	const db = new Firestore({
		projectId,
		preferRest: true,
		ignoreUndefinedProperties: true,
	});
	const ref = db.collection(COLLECTION).doc(`ci-${randomUUID()}`);
	const marker = randomUUID();

	try {
		await ref.set({ marker, at: new Date(), runner: "ci-auth-healthz" });
		const snap = await ref.get();
		if (!snap.exists || snap.get("marker") !== marker) {
			fail(
				`round-trip mismatch — wrote ${marker}, read back ${snap.get("marker") ?? "<missing>"}`,
			);
		}
		console.log(
			`[auth-healthz] OK — firebase-admin ⇄ ${projectId} Firestore round-trip succeeded on Node ${process.version}.`,
		);
		await ref.delete().catch(() => {});
		await db.terminate().catch(() => {});
	} catch (err) {
		fail(
			"firebase-admin Firestore round-trip threw — the auth outbound stack is broken (this is how prod login outages look).",
			err,
		);
	}
}

// Hard timeout: a broken keep-alive can hang rather than throw — don't let CI sit.
const timer = setTimeout(
	() =>
		fail(
			`timed out after ${TIMEOUT_MS}ms — the outbound Firestore call hung (a keep-alive / undici regression signature).`,
		),
	TIMEOUT_MS,
);
timer.unref();

main()
	.then(() => {
		clearTimeout(timer);
		process.exit(0);
	})
	.catch((err) => fail("unexpected error", err));
