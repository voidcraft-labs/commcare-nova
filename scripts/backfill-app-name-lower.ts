/**
 * Backfill `app_name_lower` onto historical app documents.
 *
 * When `listApps` grew a `sort: "name_asc"` option, the implementation
 * chose to store a pre-lowercased copy of `app_name` on disk rather
 * than sort case-sensitively at the index layer (Firestore orders
 * fields byte-wise, so without this denormalization "ZEbra" sorts
 * before "apple"). Every write path in `lib/db/apps.ts` now writes
 * `app_name_lower` via `denormalize`, but apps created before that
 * change lack the field — the composite index
 * `(owner, app_name_lower ASC)` won't place them in the ordered scan,
 * so a user's older apps would silently disappear from alphabetical
 * list pages.
 *
 * Strategy:
 *   1. Scan every doc under `apps/`, pulling only `app_name` +
 *      `app_name_lower` so the query is cheap.
 *   2. For each doc missing `app_name_lower` (or whose value has
 *      drifted from `app_name.toLowerCase()`), batch a `.update`
 *      writing the correct value.
 *   3. Commit batches at 400 writes (Firestore's WriteBatch hard
 *      limit is 500; 400 leaves headroom).
 *
 * Idempotent: re-running skips docs whose `app_name_lower` already
 * matches the expected lowercase form. Resumable after partial
 * failure.
 *
 * Usage:
 *   npx tsx scripts/backfill-app-name-lower.ts --dry-run  # count only
 *   npx tsx scripts/backfill-app-name-lower.ts            # actually write
 *
 * Must run BEFORE relying on `sort: "name_asc"` in any production
 * surface; without it, historical docs are invisible to the name-sort
 * index path. Runs in any order relative to deploys — the write path
 * itself stamps new docs with the field, so the field only keeps
 * expanding in coverage after a deploy.
 */

import "dotenv/config";
import { UNTITLED_APP_NAME } from "@/lib/db/apps";
import { getDb } from "@/lib/db/firestore";
import { log } from "@/lib/logger";

async function run(dryRun: boolean): Promise<void> {
	const db = getDb();

	/* Only the two name-related fields are needed — `app_name` is the
	 * source of truth and `app_name_lower` tells us whether a write
	 * is required. `select()` keeps the scan cheap even with thousands
	 * of apps. */
	const apps = await db
		.collection("apps")
		.select("app_name", "app_name_lower")
		.get();

	let scanned = 0;
	let updated = 0;

	let batch = db.batch();
	let batchSize = 0;

	for (const app of apps.docs) {
		scanned++;
		const data = app.data() as {
			app_name?: unknown;
			app_name_lower?: unknown;
		};

		/* Normalize the source name the same way `denormalize` does on
		 * write: fall back to the sentinel untitled name when missing or
		 * blank. Matches the on-disk display value exactly. */
		const rawName =
			typeof data.app_name === "string" && data.app_name.length > 0
				? data.app_name
				: UNTITLED_APP_NAME;
		const expected = rawName.toLowerCase();

		/* Idempotency: skip docs whose field is already correct. Drift is
		 * possible if an older script or a hand-edit wrote a stale value,
		 * so we compare actual equality, not just presence. */
		if (data.app_name_lower === expected) continue;

		if (!dryRun) {
			batch.update(app.ref, { app_name_lower: expected });
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

	log.info(
		`[backfill-app-name-lower] scanned=${scanned} updated=${updated} dryRun=${dryRun}`,
	);
}

const dry = process.argv.includes("--dry-run");
run(dry).catch((err) => {
	console.error(err);
	process.exit(1);
});
