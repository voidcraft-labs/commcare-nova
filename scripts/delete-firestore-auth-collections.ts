// scripts/delete-firestore-auth-collections.ts
//
// DESTRUCTIVE one-off: deletes the pre-cutover Better Auth Firestore
// collections. Auth state moved to Postgres in #160 and the one-shot copy was
// removed in #162, so these collections are unread backups. Run the read-only
// scan (scripts/scan-firestore-auth-collections.ts) and take a
// `gcloud firestore export` of the prod collections BEFORE running this.
//
// Safety model: the script deletes ONLY collections that are BOTH (a) in the
// fixed AUTH_COLLECTIONS set below and (b) actually present in the project —
// it re-lists root collections at run time and intersects, so app-domain
// collections (apps, credits, mediaAssets, usage, user_settings, …) are
// unreachable by construction, and the dev/prod difference (dev has only the
// trio) needs no per-project list.
//
// Usage: npx tsx scripts/delete-firestore-auth-collections.ts --project=<id> --yes

import { Firestore } from "@google-cloud/firestore";
import { firestoreClientOptions } from "@/lib/db/firestoreClientOptions";

const ALLOWED_PROJECTS = ["commcare-nova", "commcare-nova-dev"] as const;

/**
 * The full pre-cutover auth surface: the durable collections the #160 copy
 * read, the ephemeral ones it skipped (sessions, rate-limit, access tokens),
 * and the verification spellings in case one materializes. Mirrors the scan
 * script's candidate set; the 2026-07-06 scans found 11 of these in prod and
 * 3 in dev, and nothing auth-shaped outside this set.
 */
const AUTH_COLLECTIONS = new Set([
	"auth_users",
	"auth_sessions",
	"auth_accounts",
	"auth_verifications",
	"verification",
	"verifications",
	"rateLimit",
	"ratelimit",
	"oauthClient",
	"oauthConsent",
	"oauthRefreshToken",
	"oauthAccessToken",
	"oauthGrantRevocation",
	"jwks",
	"apikey",
]);

async function main(): Promise<void> {
	const arg = process.argv.find((a) => a.startsWith("--project="));
	const projectId = arg?.split("=")[1];
	if (!projectId || !ALLOWED_PROJECTS.includes(projectId as never)) {
		console.error(
			`Pass --project=<id> with one of: ${ALLOWED_PROJECTS.join(", ")}.`,
		);
		process.exit(1);
	}
	if (!process.argv.includes("--yes")) {
		console.error(
			`This permanently deletes the auth collections in ${projectId}. ` +
				"Re-run with --yes once the scan output and the prod export are in hand.",
		);
		process.exit(1);
	}
	if (process.env.FIRESTORE_EMULATOR_HOST) {
		console.error(
			"FIRESTORE_EMULATOR_HOST is set — refusing to run against an emulator " +
				"by accident. Unset it and re-run.",
		);
		process.exit(1);
	}

	const fs = new Firestore({ projectId, ...firestoreClientOptions() });
	const present = await fs.listCollections();
	const targets = present.filter((c) => AUTH_COLLECTIONS.has(c.id));
	if (targets.length === 0) {
		console.log(`${projectId}: no auth collections present — nothing to do.`);
		await fs.terminate();
		return;
	}

	console.log(`${projectId}: deleting ${targets.length} auth collection(s)…`);
	for (const col of targets) {
		const before = (await col.count().get()).data().count;
		await fs.recursiveDelete(col);
		const after = (await col.count().get()).data().count;
		if (after !== 0) {
			throw new Error(
				`${col.id}: ${after} doc(s) still present after recursiveDelete ` +
					`(started with ${before}). Stopping so the remainder can be inspected.`,
			);
		}
		console.log(`  ${col.id.padEnd(28)} ${before} → 0`);
	}

	const remaining = (await fs.listCollections()).filter((c) =>
		AUTH_COLLECTIONS.has(c.id),
	);
	console.log(
		remaining.length === 0
			? `${projectId}: done — no auth collections remain.`
			: `${projectId}: WARNING — still listed (may be eventual consistency): ${remaining.map((c) => c.id).join(", ")}`,
	);
	await fs.terminate();
}

main().catch((err) => {
	console.error("delete failed:", err);
	process.exit(1);
});
