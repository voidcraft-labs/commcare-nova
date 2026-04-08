/**
 * One-time migration: switch user identity from custom UUID to Better Auth user ID.
 *
 * For each `auth_users/{betterAuthId}` document:
 *   1. Look up email → find matching `users/{oldUUID}` doc
 *   2. Create `users/{betterAuthId}` with all fields from the old doc
 *   3. Copy `users/{oldUUID}/usage/*` to `users/{betterAuthId}/usage/*`
 *   4. Update all `apps/{appId}.owner` from oldUUID → betterAuthId
 *   5. Clean up phantom docs created by the touchUser bug
 *
 * Safe to run multiple times — uses set() which is idempotent. Does NOT
 * delete old UUID-keyed documents (run manual cleanup after verification).
 *
 * Prerequisites:
 *   - GOOGLE_CLOUD_PROJECT env var set (or running on Cloud Run)
 *
 * Usage:
 *   npx tsx scripts/migrate-users-to-better-auth-id.ts            # dry run (default)
 *   npx tsx scripts/migrate-users-to-better-auth-id.ts --commit   # write to Firestore
 */

import { Firestore } from "@google-cloud/firestore";

const DRY_RUN = !process.argv.includes("--commit");
const BATCH_SIZE = 450;

/** UUID v4 pattern — identifies old custom-UUID user docs. */
const UUID_RE =
	/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

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

	/* Step 1: Build email → Better Auth user ID map from auth_users */
	const authUsersSnap = await db.collection("auth_users").get();
	console.log(`Found ${authUsersSnap.size} auth_users document(s)\n`);

	const emailToBetterAuthId = new Map<string, string>();
	for (const doc of authUsersSnap.docs) {
		const email = doc.data().email as string;
		if (email) {
			emailToBetterAuthId.set(email, doc.id);
		}
	}

	/* Step 2: Read all current user documents and classify them */
	const usersSnap = await db.collection("users").get();
	console.log(`Found ${usersSnap.size} user document(s)\n`);

	/** Old UUID → Better Auth ID mapping for app ownership updates. */
	const oldIdToNewId = new Map<string, string>();
	/** Phantom doc IDs (Better Auth IDs with only last_active_at, created by touchUser bug). */
	const phantomDocIds: string[] = [];

	let usersCreated = 0;
	let usageCopied = 0;
	let appsUpdated = 0;
	let phantomsCleaned = 0;
	let errors = 0;

	for (const userDoc of usersSnap.docs) {
		const docId = userDoc.id;
		const data = userDoc.data();

		/* Detect phantom docs — created by the touchUser bug. These have only
		 * `last_active_at` (no email, no name, no role). Their ID is a Better Auth
		 * user ID, not a UUID. */
		if (!data.email && !data.name && !data.role && !UUID_RE.test(docId)) {
			console.log(
				`  👻 Phantom doc: ${docId} (only has: ${Object.keys(data).join(", ")})`,
			);
			phantomDocIds.push(docId);
			continue;
		}

		/* Skip docs that are already Better Auth IDs (non-UUID format with full data) */
		if (!UUID_RE.test(docId)) {
			console.log(`  ⏭ Skipping ${docId} (already a Better Auth ID)`);
			continue;
		}

		/* This is a UUID-keyed doc — find the matching Better Auth ID via email */
		const email = data.email as string | undefined;
		if (!email) {
			console.log(`  ⚠️ UUID doc ${docId} has no email field — skipping`);
			errors++;
			continue;
		}

		const betterAuthId = emailToBetterAuthId.get(email);
		if (!betterAuthId) {
			console.log(
				`  ⚠️ No auth_users entry for ${email} (UUID: ${docId}) — skipping`,
			);
			errors++;
			continue;
		}

		/* Already migrated if the target doc exists with full data */
		if (oldIdToNewId.has(docId)) {
			console.log(`  ⏭ Already mapped: ${docId}`);
			continue;
		}

		oldIdToNewId.set(docId, betterAuthId);
		console.log(`  ${docId} → ${betterAuthId} (${email})`);

		/* Step 3: Create the new user doc under the Better Auth ID */
		if (!DRY_RUN) {
			try {
				await db
					.collection("users")
					.doc(betterAuthId)
					.set({ ...data });
				usersCreated++;
			} catch (err) {
				console.error(`    ❌ Failed to create user doc for ${email}:`, err);
				errors++;
				continue;
			}
		} else {
			usersCreated++;
		}

		/* Step 4: Copy usage subcollection */
		const usageSnap = await db
			.collection("users")
			.doc(docId)
			.collection("usage")
			.get();

		if (!usageSnap.empty) {
			let batch = db.batch();
			let batchCount = 0;

			for (const usageDoc of usageSnap.docs) {
				const targetRef = db
					.collection("users")
					.doc(betterAuthId)
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

	/* Step 5: Update app ownership from old UUID to Better Auth ID */
	console.log(`\nUpdating app ownership for ${oldIdToNewId.size} user(s)...\n`);

	for (const [oldUUID, betterAuthId] of oldIdToNewId) {
		const appsSnap = await db
			.collection("apps")
			.where("owner", "==", oldUUID)
			.get();

		if (appsSnap.empty) {
			console.log(`  ${oldUUID}: 0 apps`);
			continue;
		}

		console.log(`  ${oldUUID} → ${betterAuthId}: ${appsSnap.size} app(s)`);

		let batch = db.batch();
		let batchCount = 0;

		for (const appDoc of appsSnap.docs) {
			if (!DRY_RUN) {
				batch.update(appDoc.ref, { owner: betterAuthId });
				batchCount++;

				if (batchCount >= BATCH_SIZE) {
					try {
						await batch.commit();
					} catch (err) {
						console.error(`    ❌ Failed to update app batch:`, err);
						errors++;
					}
					batch = db.batch();
					batchCount = 0;
				}
			}
			appsUpdated++;
		}

		if (!DRY_RUN && batchCount > 0) {
			try {
				await batch.commit();
			} catch (err) {
				console.error(`    ❌ Failed to write final app batch:`, err);
				errors++;
			}
		}
	}

	/* Step 6: Clean up phantom docs */
	if (phantomDocIds.length > 0) {
		console.log(`\nCleaning up ${phantomDocIds.length} phantom doc(s)...\n`);

		for (const phantomId of phantomDocIds) {
			console.log(`  🗑 ${phantomId}`);
			if (!DRY_RUN) {
				try {
					await db.collection("users").doc(phantomId).delete();
					phantomsCleaned++;
				} catch (err) {
					console.error(
						`    ❌ Failed to delete phantom doc ${phantomId}:`,
						err,
					);
					errors++;
				}
			} else {
				phantomsCleaned++;
			}
		}
	}

	/* Summary */
	console.log();
	console.log("─".repeat(50));
	console.log(`Users migrated:    ${usersCreated}`);
	console.log(`Usage periods:     ${usageCopied}`);
	console.log(`Apps updated:      ${appsUpdated}`);
	console.log(`Phantoms cleaned:  ${phantomsCleaned}`);
	console.log(`Errors:            ${errors}`);
	console.log();
	console.log("UUID → Better Auth ID mapping:");
	for (const [oldId, newId] of oldIdToNewId) {
		console.log(`  ${oldId} → ${newId}`);
	}
	console.log(
		DRY_RUN
			? "\nRe-run with --commit to write changes."
			: "\n✅ Migration complete. Verify, then manually delete old UUID docs.",
	);
}

migrate().catch((err) => {
	console.error("Migration failed:", err);
	process.exit(1);
});
