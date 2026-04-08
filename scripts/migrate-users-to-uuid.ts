/**
 * One-time migration: switch user identity from email-keyed to UUID-keyed.
 *
 * For each `users/{email}` document:
 *   1. Generate a UUID
 *   2. Create `users/{uuid}` with all fields + `email` field
 *   3. Update all `apps/{appId}.owner` from email → uuid
 *   4. Copy `users/{email}/usage/*` to `users/{uuid}/usage/*`
 *
 * Logs the email → UUID mapping for audit. Safe to run multiple times —
 * uses set() which is idempotent. Does NOT delete old data (run manual
 * cleanup after verification).
 *
 * Prerequisites:
 *   - Firestore index on `users.email` (ascending) must be created first
 *   - GOOGLE_CLOUD_PROJECT env var set (or running on Cloud Run)
 *
 * Usage:
 *   npx tsx scripts/migrate-users-to-uuid.ts              # dry run (default)
 *   npx tsx scripts/migrate-users-to-uuid.ts --commit      # write to Firestore
 */

import { randomUUID } from "node:crypto";
import { Firestore } from "@google-cloud/firestore";

const DRY_RUN = !process.argv.includes("--commit");
const BATCH_SIZE = 450;

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

	/* Step 1: Read all existing user documents (email-keyed) */
	const usersSnap = await db.collection("users").get();
	console.log(`Found ${usersSnap.size} user document(s)\n`);

	/** Email → UUID mapping for audit trail and app ownership updates. */
	const emailToUuid = new Map<string, string>();

	let usersCreated = 0;
	let usageCopied = 0;
	let appsUpdated = 0;
	let errors = 0;

	/* Step 2: Create UUID-keyed user documents */
	for (const userDoc of usersSnap.docs) {
		const email = userDoc.id;
		const data = userDoc.data();

		/* Skip documents that already look like UUIDs (re-run safety).
		 * UUID v4 pattern: 8-4-4-4-12 hex characters. */
		if (
			/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
				email,
			)
		) {
			console.log(`  ⏭ Skipping ${email} (already a UUID)`);
			continue;
		}

		const uuid = randomUUID();
		emailToUuid.set(email, uuid);

		console.log(`  ${email} → ${uuid}`);

		if (!DRY_RUN) {
			try {
				await db
					.collection("users")
					.doc(uuid)
					.set({ ...data, email });
				usersCreated++;
			} catch (err) {
				console.error(`    ❌ Failed to create user doc for ${email}:`, err);
				errors++;
				continue;
			}
		} else {
			usersCreated++;
		}

		/* Step 3: Copy usage subcollection */
		const usageSnap = await db
			.collection("users")
			.doc(email)
			.collection("usage")
			.get();

		if (!usageSnap.empty) {
			let batch = db.batch();
			let batchCount = 0;

			for (const usageDoc of usageSnap.docs) {
				const targetRef = db
					.collection("users")
					.doc(uuid)
					.collection("usage")
					.doc(usageDoc.id);

				if (!DRY_RUN) {
					batch.set(targetRef, usageDoc.data());
					batchCount++;

					if (batchCount >= BATCH_SIZE) {
						try {
							await batch.commit();
						} catch (err) {
							console.error(
								`    ❌ Failed to write usage batch for ${email}:`,
								err,
							);
							errors++;
						}
						batch = db.batch();
						batchCount = 0;
					}
				}
				usageCopied++;
			}

			/* Flush remaining batch */
			if (!DRY_RUN && batchCount > 0) {
				try {
					await batch.commit();
				} catch (err) {
					console.error(
						`    ❌ Failed to write final usage batch for ${email}:`,
						err,
					);
					errors++;
				}
			}

			console.log(`       ${usageSnap.size} usage period(s) copied`);
		}
	}

	/* Step 4: Update app ownership from email to UUID */
	console.log(`\nUpdating app ownership for ${emailToUuid.size} user(s)...\n`);

	for (const [email, uuid] of emailToUuid) {
		const appsSnap = await db
			.collection("apps")
			.where("owner", "==", email)
			.get();

		if (appsSnap.empty) {
			console.log(`  ${email}: 0 apps`);
			continue;
		}

		console.log(`  ${email}: ${appsSnap.size} app(s)`);

		let batch = db.batch();
		let batchCount = 0;

		for (const appDoc of appsSnap.docs) {
			if (!DRY_RUN) {
				batch.update(appDoc.ref, { owner: uuid });
				batchCount++;

				if (batchCount >= BATCH_SIZE) {
					try {
						await batch.commit();
					} catch (err) {
						console.error(
							`    ❌ Failed to update app batch for ${email}:`,
							err,
						);
						errors++;
					}
					batch = db.batch();
					batchCount = 0;
				}
			}
			appsUpdated++;
		}

		/* Flush remaining batch */
		if (!DRY_RUN && batchCount > 0) {
			try {
				await batch.commit();
			} catch (err) {
				console.error(
					`    ❌ Failed to write final app batch for ${email}:`,
					err,
				);
				errors++;
			}
		}
	}

	/* Summary */
	console.log();
	console.log("─".repeat(50));
	console.log(`Users created:  ${usersCreated}`);
	console.log(`Usage periods:  ${usageCopied}`);
	console.log(`Apps updated:   ${appsUpdated}`);
	console.log(`Errors:         ${errors}`);
	console.log();
	console.log("Email → UUID mapping:");
	for (const [email, uuid] of emailToUuid) {
		console.log(`  ${email} → ${uuid}`);
	}
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
