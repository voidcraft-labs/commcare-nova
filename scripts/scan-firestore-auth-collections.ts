// scripts/scan-firestore-auth-collections.ts
//
// READ-ONLY scan preceding the deletion of the pre-cutover Better Auth
// Firestore collections (auth moved to Postgres in #160; #162 removed the
// one-shot copy). Lists every root collection in the given project's default
// Firestore database with an aggregate doc count, and marks which ones are
// auth collections (the copy's durable sources plus the ephemeral collections
// the copy deliberately skipped). Everything unmarked is app-domain data and
// must NOT be touched by the delete step.
//
// Usage: npx tsx scripts/scan-firestore-auth-collections.ts --project=<commcare-nova|commcare-nova-dev>

import { Firestore } from "@google-cloud/firestore";
import { firestoreClientOptions } from "@/lib/db/firestoreClientOptions";

const ALLOWED_PROJECTS = ["commcare-nova", "commcare-nova-dev"] as const;

/**
 * The pre-cutover auth collections: the durable sources the #160 copy read
 * (auth_users, auth_accounts, oauthClient, apikey, oauthConsent,
 * oauthRefreshToken, oauthGrantRevocation, jwks) plus the ephemeral ones it
 * skipped (sessions, verification, rate-limit — written by the deleted
 * Firestore adapter under its own names, so both spellings are listed and the
 * scan reports whichever actually exist).
 */
const AUTH_COLLECTION_CANDIDATES = new Set([
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
			`Pass --project=<id> with one of: ${ALLOWED_PROJECTS.join(", ")}. ` +
				"This scan is read-only, but the allowlist keeps it (and the delete " +
				"script that mirrors it) from ever pointing at a stranger's project.",
		);
		process.exit(1);
	}
	if (process.env.FIRESTORE_EMULATOR_HOST) {
		console.error(
			"FIRESTORE_EMULATOR_HOST is set — this scan is meant for the real " +
				"project databases. Unset it and re-run.",
		);
		process.exit(1);
	}

	const fs = new Firestore({ projectId, ...firestoreClientOptions() });
	const collections = await fs.listCollections();
	console.log(
		`\n${projectId} — ${collections.length} root collection(s) in the default database:\n`,
	);
	const rows: { name: string; count: number; auth: boolean }[] = [];
	for (const col of collections) {
		const snap = await col.count().get();
		rows.push({
			name: col.id,
			count: snap.data().count,
			auth: AUTH_COLLECTION_CANDIDATES.has(col.id),
		});
	}
	for (const r of rows.sort((a, b) => a.name.localeCompare(b.name))) {
		console.log(
			`${r.auth ? "AUTH " : "     "} ${r.name.padEnd(28)} ${r.count} docs`,
		);
	}
	const authRows = rows.filter((r) => r.auth);
	console.log(
		`\n${authRows.length} auth collection(s), ${authRows.reduce((s, r) => s + r.count, 0)} doc(s) total:`,
	);
	console.log(authRows.map((r) => r.name).join(","));
	await fs.terminate();
}

main().catch((err) => {
	console.error("scan failed:", err);
	process.exit(1);
});
