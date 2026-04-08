/**
 * One-time migration: promote apps from subcollections to root-level collection.
 *
 * Reads all `users/{email}/apps/{appId}` documents and writes each to
 * `apps/{appId}` with an `owner` field set to the parent user's email.
 * Also copies all log subcollections (`users/{email}/apps/{appId}/logs/*`)
 * to `apps/{appId}/logs/*`.
 *
 * Safe to run multiple times — uses set() which is idempotent. Does NOT
 * delete old data (run manual cleanup after verification).
 *
 * Usage:
 *   npx tsx scripts/migrate-apps-to-root.ts              # dry run (default)
 *   npx tsx scripts/migrate-apps-to-root.ts --commit      # write to Firestore
 */

import { Firestore } from "@google-cloud/firestore";

const DRY_RUN = !process.argv.includes("--commit");

async function migrate() {
	const db = new Firestore({
		projectId: process.env.GOOGLE_CLOUD_PROJECT,
		ignoreUndefinedProperties: true,
		preferRest: true,
	});

	console.log(
		DRY_RUN
			? "🔍 DRY RUN — no writes"
			: "🔥 COMMIT MODE — writing to Firestore",
	);
	console.log();

	/* Step 1: List all user documents */
	const usersSnap = await db.collection("users").get();
	console.log(`Found ${usersSnap.size} user(s)`);

	let totalApps = 0;
	let totalLogs = 0;
	let errors = 0;

	for (const userDoc of usersSnap.docs) {
		const email = userDoc.id;

		/* Step 2: Read all apps for this user */
		const appsSnap = await db
			.collection("users")
			.doc(email)
			.collection("apps")
			.get();

		if (appsSnap.empty) continue;
		console.log(`  ${email}: ${appsSnap.size} app(s)`);

		for (const appDoc of appsSnap.docs) {
			const appId = appDoc.id;
			const appData = appDoc.data();

			/* Step 3: Write app to root-level collection with owner field */
			const targetRef = db.collection("apps").doc(appId);

			if (!DRY_RUN) {
				try {
					await targetRef.set({ ...appData, owner: email });
				} catch (err) {
					console.error(`    ❌ Failed to write app ${appId}:`, err);
					errors++;
					continue;
				}
			}
			totalApps++;
			console.log(`    ✅ app ${appId}`);

			/* Step 4: Copy all log documents */
			const logsSnap = await db
				.collection("users")
				.doc(email)
				.collection("apps")
				.doc(appId)
				.collection("logs")
				.get();

			if (logsSnap.empty) continue;

			/* Batch writes for efficiency — Firestore limit is 500 per batch */
			const BATCH_SIZE = 450;
			let batch = db.batch();
			let batchCount = 0;

			for (const logDoc of logsSnap.docs) {
				const targetLogRef = db
					.collection("apps")
					.doc(appId)
					.collection("logs")
					.doc(logDoc.id);

				if (!DRY_RUN) {
					batch.set(targetLogRef, logDoc.data());
					batchCount++;

					if (batchCount >= BATCH_SIZE) {
						try {
							await batch.commit();
						} catch (err) {
							console.error(
								`    ❌ Failed to write log batch for ${appId}:`,
								err,
							);
							errors++;
						}
						batch = db.batch();
						batchCount = 0;
					}
				}
				totalLogs++;
			}

			/* Flush remaining batch */
			if (!DRY_RUN && batchCount > 0) {
				try {
					await batch.commit();
				} catch (err) {
					console.error(
						`    ❌ Failed to write final log batch for ${appId}:`,
						err,
					);
					errors++;
				}
			}

			console.log(`       ${logsSnap.size} log event(s)`);
		}
	}

	console.log();
	console.log("─".repeat(50));
	console.log(`Apps migrated:  ${totalApps}`);
	console.log(`Logs migrated:  ${totalLogs}`);
	console.log(`Errors:         ${errors}`);
	console.log(
		DRY_RUN
			? "\nRe-run with --commit to write changes."
			: "\n✅ Migration complete.",
	);
}

migrate().catch((err) => {
	console.error("Migration failed:", err);
	process.exit(1);
});
