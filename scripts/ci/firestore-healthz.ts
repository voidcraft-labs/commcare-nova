/**
 * CI Firestore app-data outbound healthz — guards the REAL Firestore data path
 * the app still depends on. After the auth Postgres cutover, auth no longer
 * touches Firestore, but apps / threads / runs / credits / usage / media all
 * STILL live there, so a regression in the outbound stack that path rides on
 * must still red a PR.
 *
 * Why this exists separately from the Playwright smoke: the smoke points the app
 * at a Firestore EMULATOR, which talks plain HTTP to localhost and skips the
 * Google token fetch + metadata server — i.e. it stubs out the exact outbound
 * network layer that breaks. This gate does what prod does: a REAL
 * firebase-admin → REAL Firestore round-trip over the real outbound HTTP stack,
 * on the exact Node patch prod ships, doing create → read → delete. The
 * firebase-admin Firestore client is built with the SAME options as the app's
 * client (`lib/db/firestore`, via the shared `firestoreClientOptions`).
 *
 * The auth/login path is a DIFFERENT gate now: login runs on the Cloud SQL
 * connector, whose credential stack is exercised head-on (no database) by
 * `scripts/ci/auth-healthz.ts`. This script's job is specifically the Firestore
 * DATA path (google-gax / the Firestore wire) plus its own credential leg.
 *
 * Run against the isolated `commcare-nova-ci` project (its own empty Firestore —
 * no real data anywhere) via keyless WIF. REFUSES to run against the emulator —
 * the whole point is the real network.
 */
import { randomUUID } from "node:crypto";
import { Firestore } from "firebase-admin/firestore";
import { firestoreClientOptions } from "@/lib/db/firestoreClientOptions";
import { runHealthz } from "./healthz-harness";

const COLLECTION = "ci_healthz";

runHealthz("firestore-healthz", async () => {
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

	// Same options as lib/db/firestore.ts (REST here — the guard above ensures no
	// emulator). ADC comes from google-github-actions/auth (WIF) in CI, or
	// `gcloud auth application-default login` locally.
	const db = new Firestore({ projectId, ...firestoreClientOptions() });
	const ref = db.collection(COLLECTION).doc(`ci-${randomUUID()}`);
	const marker = randomUUID();

	try {
		await ref.set({ marker, at: new Date(), runner: "ci-firestore-healthz" });
		const snap = await ref.get();
		if (!snap.exists || snap.get("marker") !== marker) {
			throw new Error(
				`round-trip mismatch — wrote ${marker}, read back ${snap.get("marker") ?? "<missing>"}`,
			);
		}
		return `firebase-admin ⇄ ${projectId} Firestore round-trip succeeded on Node ${process.version}.`;
	} finally {
		await ref.delete().catch(() => {});
		await db.terminate().catch(() => {});
	}
});
