#!/usr/bin/env npx tsx
/**
 * One-time migration: eliminate the custom `users/{userId}` collection.
 *
 * What this does:
 *   1. Backfills `lastActiveAt` on `auth_users` from `users/{userId}.last_active_at`.
 *   2. Copies usage docs from `users/{userId}/usage/{period}` to `usage/{userId}/months/{period}`.
 *
 * What this does NOT do:
 *   - Delete the old `users/` collection. Manual cleanup after verification.
 *
 * Run this BEFORE deploying the code changes so the new paths have data
 * when the code goes live.
 *
 * Usage:
 *   npx tsx scripts/migrate-users.ts                # dry run (default)
 *   npx tsx scripts/migrate-users.ts --commit       # actually write to Firestore
 *
 * Environment variables:
 *   GOOGLE_CLOUD_PROJECT — Firestore project ID (auto-detected on Cloud Run)
 */

import { Firestore } from "@google-cloud/firestore";

const DRY_RUN = !process.argv.includes("--commit");
const MAX_BATCH_OPS = 450; // Stay under Firestore's 500-per-batch limit

async function main() {
	const db = new Firestore({
		projectId: process.env.GOOGLE_CLOUD_PROJECT,
		preferRest: true,
	});

	console.log(
		DRY_RUN
			? "[DRY RUN] No writes will be made.\n"
			: "[LIVE] Writing to Firestore.\n",
	);

	/* ── Step 1: Read all user docs ─────────────────────────────── */

	const usersSnap = await db.collection("users").get();
	console.log(`Found ${usersSnap.size} user(s) in 'users/' collection.\n`);

	if (usersSnap.empty) {
		console.log("Nothing to migrate.");
		return;
	}

	let batch = db.batch();
	let batchOps = 0;
	let usersBackfilled = 0;
	let usageDocsCopied = 0;
	let batchesCommitted = 0;

	/** Commit the current batch and start a new one. */
	async function flushBatch(): Promise<void> {
		if (batchOps === 0) return;
		if (!DRY_RUN) {
			await batch.commit();
		}
		batchesCommitted++;
		batch = db.batch();
		batchOps = 0;
	}

	/** Add an operation to the batch, flushing if near the limit. */
	async function addToBatch(
		op: (b: FirebaseFirestore.WriteBatch) => void,
	): Promise<void> {
		if (batchOps >= MAX_BATCH_OPS) {
			await flushBatch();
		}
		op(batch);
		batchOps++;
	}

	for (const userDoc of usersSnap.docs) {
		const userId = userDoc.id;
		const userData = userDoc.data();

		/* ── Step 2: Backfill lastActiveAt on auth_users ─────────── */

		const lastActiveAt = userData.last_active_at;
		if (lastActiveAt) {
			const authUserRef = db.collection("auth_users").doc(userId);
			await addToBatch((b) =>
				b.set(authUserRef, { lastActiveAt }, { merge: true }),
			);
			usersBackfilled++;
			console.log(`  [user] ${userId} → backfilled lastActiveAt`);
		} else {
			console.log(`  [user] ${userId} → no last_active_at, skipping backfill`);
		}

		/* ── Step 3: Copy usage subcollection (idempotent) ───────── */

		const usageSnap = await db
			.collection("users")
			.doc(userId)
			.collection("usage")
			.get();

		for (const usageDoc of usageSnap.docs) {
			const newRef = db
				.collection("usage")
				.doc(userId)
				.collection("months")
				.doc(usageDoc.id);

			/* Skip if the destination already exists — prevents clobbering
			 * usage data that accumulated at the new path after a prior run. */
			const existingSnap = await newRef.get();
			if (existingSnap.exists) {
				console.log(
					`  [usage] ${userId}/${usageDoc.id} → already exists, skipping`,
				);
				continue;
			}

			await addToBatch((b) => b.set(newRef, usageDoc.data()));
			usageDocsCopied++;
			console.log(`  [usage] ${userId}/${usageDoc.id} → copied`);
		}
	}

	/* Flush any remaining operations */
	await flushBatch();

	/* ── Summary ───────────────────────────────────────────────── */

	console.log("\n--- Migration Summary ---");
	console.log(`  Users backfilled:    ${usersBackfilled}`);
	console.log(`  Usage docs copied:   ${usageDocsCopied}`);
	console.log(`  Batches committed:   ${batchesCommitted}`);
	console.log(`  Mode:                ${DRY_RUN ? "DRY RUN" : "LIVE"}`);

	if (DRY_RUN) {
		console.log("\nRe-run with --commit to apply changes.");
	} else {
		console.log(
			"\nMigration complete. Verify, then manually delete 'users/' collection.",
		);
	}
}

main().catch((err) => {
	console.error("Migration failed:", err);
	process.exit(1);
});
