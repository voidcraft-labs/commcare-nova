/**
 * One-off: clear the removed `active_domain` field from `user_settings` docs.
 *
 * `active_domain` was a single-key-era artifact — a stored "default upload
 * space" that no longer fits the model: a single-space key resolves to its sole
 * space at upload time, and a multi-space key's target is chosen per upload (a
 * key reaching many spaces exists to operate across them, so a remembered
 * default only ever mis-targeted). The field is gone from the schema, so reads
 * already strip it; this clears the stored value so the data matches the code.
 *
 * Dry-run by default — reports how many docs still carry the field. Pass
 * `--apply` to delete it.
 *
 *   npx tsx scripts/migrate-remove-active-domain.ts            # scan only
 *   npx tsx scripts/migrate-remove-active-domain.ts --apply    # delete it
 *
 * Idempotent (a second run finds nothing) and order-independent: reads strip
 * the unknown field regardless, so this can run before or after the deploy
 * that removes it. Purely data tidiness — nothing breaks if it never runs.
 */

import "dotenv/config";
import { FieldValue } from "@google-cloud/firestore";
import { getDb } from "@/lib/db/firestore";
import { log } from "@/lib/logger";

/** Firestore's WriteBatch hard limit is 500; commit at 400 for headroom. */
const BATCH_LIMIT = 400;

async function run(apply: boolean): Promise<void> {
	/* Raw collection handle — NO Zod converter. The converter strips unknown
	 * keys on read, so a converted read would never reveal which docs still
	 * carry `active_domain`. We need the raw field to find and clear it. */
	const snap = await getDb().collection("user_settings").get();

	let carrying = 0;
	let cleared = 0;
	let batch = getDb().batch();
	let pending = 0;

	for (const doc of snap.docs) {
		if (!("active_domain" in doc.data())) continue;
		carrying++;
		if (!apply) continue;

		batch.update(doc.ref, { active_domain: FieldValue.delete() });
		pending++;
		if (pending === BATCH_LIMIT) {
			await batch.commit();
			cleared += pending;
			batch = getDb().batch();
			pending = 0;
		}
	}
	if (apply && pending > 0) {
		await batch.commit();
		cleared += pending;
	}

	log.info(
		`[migrate-remove-active-domain] scanned ${snap.size} user_settings doc(s); ${carrying} carry active_domain`,
	);
	log.info(
		apply
			? `[migrate-remove-active-domain] cleared the field on ${cleared} doc(s)`
			: `[migrate-remove-active-domain] dry run — re-run with --apply to clear ${carrying} doc(s)`,
	);
}

run(process.argv.includes("--apply")).then(
	() => process.exit(0),
	(err) => {
		log.error("[migrate-remove-active-domain] failed", err);
		process.exit(1);
	},
);
