/**
 * Backfill `repeat_mode: "user_controlled"` onto historical repeat
 * fields.
 *
 * Repeat fields written before the repeat-modes feature (phase 2) lack
 * a `repeat_mode` discriminator. The field schema is now a
 * discriminated union over `repeat_mode` (`user_controlled` |
 * `count_bound` | `query_bound`), so any read through `fieldSchema`
 * fails on legacy repeats. This script backfills `user_controlled` —
 * the default that requires no extra fields — onto every legacy repeat
 * so reads remain valid after the schema-enforcing deploy goes live.
 *
 * Strategy:
 *   1. Scan every doc under `apps/` (raw read, bypassing the Zod
 *      converter on `collections.apps()` — that converter would reject
 *      pre-migration docs outright).
 *   2. For each app, walk `blueprint.fields` and identify
 *      `kind === "repeat"` entries whose `repeat_mode` is undefined.
 *   3. For each such field, stamp
 *      `blueprint.fields.<uuid>.repeat_mode = "user_controlled"` via
 *      Firestore's dot-path field-update API. That writes only the
 *      single attribute slot — the rest of the blueprint is untouched.
 *   4. One `.update(...)` per app, batching all fields-to-fix into the
 *      same write so a partial app never lands.
 *
 * Idempotent: re-running skips any field that already has a
 * `repeat_mode` set, so partial runs can be resumed safely.
 *
 * Usage:
 *   npx tsx scripts/migrate-repeat-modes.ts --dry-run   # count only
 *   npx tsx scripts/migrate-repeat-modes.ts             # actually write
 *
 * Must run BEFORE the app version that enforces the new schema on
 * reads is deployed — otherwise loading any app containing a repeat
 * field (e.g. existing household-registration apps with a `members`
 * repeat) starts failing for every consumer that goes through
 * `appDocSchema.parse` (the Firestore converter, the upload route, the
 * doc-store hydrator).
 *
 * ──────────────────────────────────────────────────────────────────
 * DEPLOY ORDER (load-bearing):
 *   1. Run this script against production Firestore (live, not --dry-run).
 *   2. THEN deploy the app version that enforces `repeat_mode` on the
 *      field schema.
 *
 * The reverse order breaks loads of any app whose blueprint includes a
 * repeat field. Symptom: `getApp`, `loadAppBlueprint`, and the doc-
 * store hydrator throw on the discriminator narrow.
 *
 * If you deployed first by accident: run this script with no flags;
 * loads self-heal as soon as each app's blueprint is backfilled.
 *   Rollback option: redeploy the previous app version.
 * ──────────────────────────────────────────────────────────────────
 */

import "dotenv/config";
import { getDb } from "@/lib/db/firestore";
import { log } from "@/lib/logger";

/**
 * Loose shape we read out of Firestore. The real `Field` discriminated
 * union would reject these docs (that's the whole point of running this
 * script), so we type the read as `unknown`-ish and inspect the shape
 * defensively. Once the migration completes every doc will satisfy the
 * strict schema.
 */
type MaybeRepeatField = {
	kind?: unknown;
	repeat_mode?: unknown;
};

async function run(dryRun: boolean): Promise<void> {
	/* Unconditional deploy-order warning — prints on every invocation
	 * (dry-run AND live). Surfaces the operational risk before any
	 * Firestore traffic so operators see it even when scrolling logs
	 * after the fact. */
	console.warn(
		"[migrate-repeat-modes] DEPLOY ORDER: run this BEFORE deploying the\n" +
			"  schema-enforcing app. Reverse order breaks loads of any app\n" +
			"  whose blueprint contains a repeat field — the discriminated\n" +
			"  field schema rejects repeats without `repeat_mode`.",
	);

	const db = getDb();
	/* Raw collection read — skip `collections.apps()` (which applies the
	 * Zod converter). Pre-migration docs would fail that converter on
	 * the very repeats we're trying to fix. */
	const apps = await db.collection("apps").get();
	let scannedApps = 0;
	let scannedRepeats = 0;
	let updatedRepeats = 0;
	let updatedApps = 0;

	for (const app of apps.docs) {
		scannedApps++;
		const data = app.data() as {
			blueprint?: { fields?: Record<string, MaybeRepeatField> };
		};
		const fields = data.blueprint?.fields;
		if (!fields) continue;

		/* Per-app update map — one Firestore `.update()` per app, with
		 * dot-path keys so each repeat's `repeat_mode` slot is written
		 * in isolation. The rest of the blueprint (every non-repeat
		 * field, every other repeat that already has a mode) stays
		 * untouched. */
		const updates: Record<string, unknown> = {};
		for (const [uuid, field] of Object.entries(fields)) {
			if (!field || field.kind !== "repeat") continue;
			scannedRepeats++;
			/* Idempotency: any defined value (including a value the
			 * SA already produced under the new schema) is respected.
			 * Re-runs skip already-migrated repeats. */
			if (field.repeat_mode !== undefined) continue;
			updates[`blueprint.fields.${uuid}.repeat_mode`] = "user_controlled";
			updatedRepeats++;
		}
		if (Object.keys(updates).length === 0) continue;
		if (!dryRun) {
			await app.ref.update(updates);
		}
		updatedApps++;
	}

	log.info(
		`[migrate-repeat-modes] scannedApps=${scannedApps} scannedRepeats=${scannedRepeats} updatedApps=${updatedApps} updatedRepeats=${updatedRepeats} dryRun=${dryRun}`,
	);
}

if (process.argv.includes("--help") || process.argv.includes("-h")) {
	console.log(
		[
			"migrate-repeat-modes — backfill repeat_mode on legacy repeat fields.",
			"",
			"Usage:",
			"  npx tsx scripts/migrate-repeat-modes.ts --dry-run   count only",
			"  npx tsx scripts/migrate-repeat-modes.ts             actually write",
			"",
			"Run BEFORE deploying the schema-enforcing app version. See the",
			"docblock at the top of this file for the deploy-order details.",
		].join("\n"),
	);
	process.exit(0);
}

const dry = process.argv.includes("--dry-run");
run(dry).catch((err) => {
	console.error(err);
	process.exit(1);
});
