/**
 * Backfill `source: "chat"` onto historical event envelopes.
 *
 * Every event written before the MCP surface landed lacks a `source`
 * field. The schema now requires it, so any read through `eventSchema`
 * would fail on those docs. This script backfills the field on every
 * app's event subcollection so reads remain valid after the
 * schema-enforcing deploy goes live.
 *
 * Strategy:
 *   1. Scan every app doc under `apps/`.
 *   2. For each, raw-read `apps/{appId}/events/` (bypassing the Zod
 *      converter on `collections.events()` — the converter would
 *      reject the pre-migration docs outright).
 *   3. For each event doc lacking a `source` field, batch a `.update`
 *      to stamp `source: "chat"`. Every pre-MCP event came from the
 *      chat surface, so a blanket "chat" backfill is correct by
 *      construction.
 *   4. Commit batches at 400 writes (Firestore's WriteBatch hard limit
 *      is 500; 400 leaves headroom).
 *
 * Idempotent: re-running skips any doc that already has the field set,
 * so partial runs can be resumed safely.
 *
 * Usage:
 *   npx tsx scripts/migrate-event-source.ts --dry-run   # count only
 *   npx tsx scripts/migrate-event-source.ts             # actually write
 *
 * Must run BEFORE the app version that enforces the new schema on reads
 * is deployed — otherwise historical reads (replay, admin inspection)
 * will start failing.
 */

import "dotenv/config";
import { getDb } from "@/lib/db/firestore";
import { log } from "@/lib/logger";

async function run(dryRun: boolean): Promise<void> {
	const db = getDb();
	/* `.select()` with no args fetches only doc references (no field data)
	 * — the per-app loop doesn't need any app-doc fields, it just needs
	 * the id + a subcollection handle. */
	const apps = await db.collection("apps").select().get();
	let scanned = 0;
	let updated = 0;

	for (const app of apps.docs) {
		/* Raw subcollection handle — skip the Zod converter on
		 * `collections.events(appId)`, which would reject pre-migration
		 * docs for missing `source`. */
		const eventsRef = app.ref.collection("events");
		const events = await eventsRef.get();

		let batch = db.batch();
		let batchSize = 0;

		for (const ev of events.docs) {
			scanned++;
			const data = ev.data() as { source?: unknown };
			// Idempotency: any truthy pre-existing value is respected.
			if (data.source !== undefined) continue;
			if (!dryRun) {
				batch.update(ev.ref, { source: "chat" });
				batchSize++;
			}
			updated++;

			/* Flush at 400 writes — safely under Firestore's 500-write
			 * WriteBatch limit. */
			if (batchSize >= 400) {
				await batch.commit();
				batch = db.batch();
				batchSize = 0;
			}
		}

		if (batchSize > 0) await batch.commit();
	}

	log.info(
		`[migrate-event-source] scanned=${scanned} updated=${updated} dryRun=${dryRun}`,
	);
}

const dry = process.argv.includes("--dry-run");
run(dry).catch((err) => {
	console.error(err);
	process.exit(1);
});
