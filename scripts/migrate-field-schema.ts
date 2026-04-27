/**
 * Backfill blueprint-field schema migrations onto historical apps.
 *
 * Two migrations live here. Both apply at the same blueprint level
 * (`blueprint.fields.<uuid>.<key>`), both are idempotent, both must run
 * before the schema-enforcing app version is deployed, so they batch
 * into a single per-app `.update()` call.
 *
 * Migration 1 — repeat_mode backfill
 *   Repeat fields written before the repeat-modes feature lack a
 *   `repeat_mode` discriminator. The field schema is now a discriminated
 *   union over `repeat_mode` (`user_controlled` | `count_bound` |
 *   `query_bound`), so any read through `fieldSchema` fails on legacy
 *   repeats. We stamp `user_controlled` (the default that requires no
 *   extra fields) onto every legacy repeat so reads remain valid.
 *
 * Migration 2 — case_property → case_property_on rename
 *   Field-level case-type pointer was renamed from `case_property` to
 *   `case_property_on`. The bare name `case_property` reads as a noun
 *   phrase ("a case property") and trained the SA to treat its value as
 *   a property name rather than a type pointer — observed symptom: SA
 *   prefixed field ids with the case-type name (e.g. `m_registration_date`
 *   for case_property `member`) to "disambiguate," wasting tool calls
 *   on follow-up renames. The `_on` suffix forces the prepositional
 *   reading. We rename the storage key on every field that still carries
 *   the old name.
 *
 * Strategy:
 *   1. Scan every doc under `apps/` (raw read, bypassing the Zod
 *      converter on `collections.apps()` — that converter would reject
 *      pre-migration docs outright).
 *   2. For each app, walk `blueprint.fields` and collect dot-path
 *      updates for any field that needs either migration applied.
 *   3. One `.update(...)` per app, batching every fix into the same
 *      write so a partial app never lands.
 *
 * Idempotent: re-running skips fields that already satisfy the new
 * schema (repeats with a `repeat_mode` set; fields without the legacy
 * `case_property` key), so partial runs can be resumed safely.
 *
 * Usage:
 *   npx tsx scripts/migrate-field-schema.ts --dry-run   # count only
 *   npx tsx scripts/migrate-field-schema.ts             # actually write
 *
 * Must run BEFORE the app version that enforces the new schema on
 * reads is deployed — otherwise loading any app containing a repeat
 * field (e.g. existing household-registration apps with a `members`
 * repeat) starts failing for every consumer that goes through
 * `appDocSchema.parse` (the Firestore converter, the upload route, the
 * doc-store hydrator). The `case_property` rename is similarly load-
 * bearing: code post-deploy reads `case_property_on` exclusively, so
 * any field still carrying the legacy key effectively loses its
 * case-type pointer (silent: Zod's default-strip drops the unknown key
 * rather than throwing), and the field ends up writing to whatever case
 * type the form's primary case happens to be.
 *
 * ──────────────────────────────────────────────────────────────────
 * DEPLOY ORDER (load-bearing):
 *   1. Run this script against production Firestore (live, not --dry-run).
 *   2. THEN deploy the app version that enforces the new field schema.
 *
 * The reverse order breaks loads of any app whose blueprint includes a
 * repeat field, AND silently strips the case-type pointer on every
 * field still using the legacy `case_property` key. Symptom: `getApp`,
 * `loadAppBlueprint`, and the doc-store hydrator throw on the repeat
 * discriminator narrow; the case-type rename is silent and only
 * surfaces when a generated app routes its writes to the wrong case.
 *
 * If you deployed first by accident, the two migrations recover
 * differently:
 *
 *   - repeat_mode backfill — running this script self-heals affected
 *     apps as they are backfilled. The schema rejects a missing
 *     `repeat_mode` as a hard parse failure, so no app loaded in the
 *     gap can write a stripped doc back to Firestore — the legacy data
 *     stays intact and the script can do its job.
 *   - case_property rename — Zod's default-strip drops the unrecognized
 *     legacy key on parse, so any app loaded and re-saved between the
 *     bad deploy and the backfill loses its case-type pointer in raw
 *     Firestore, after which this script has nothing to rename.
 *     Preferred recovery: redeploy the previous app version, run this
 *     script, then redeploy the new version.
 * ──────────────────────────────────────────────────────────────────
 */

import "dotenv/config";
import { FieldValue } from "firebase-admin/firestore";
import { getDb } from "@/lib/db/firestore";
import { log } from "@/lib/logger";

/**
 * Loose shape we read out of Firestore. The real `Field` discriminated
 * union would reject these docs (that's the whole point of running this
 * script), so we type the read as `unknown`-ish and inspect the shape
 * defensively. Once the migration completes every doc will satisfy the
 * strict schema.
 */
type LegacyField = {
	kind?: unknown;
	repeat_mode?: unknown;
	/** Legacy key being renamed to `case_property_on`. */
	case_property?: unknown;
	/** Post-migration name. Presence here means already migrated. */
	case_property_on?: unknown;
};

async function run(dryRun: boolean): Promise<void> {
	/* Unconditional deploy-order warning — prints on every invocation
	 * (dry-run AND live). Surfaces the operational risk before any
	 * Firestore traffic so operators see it even when scrolling logs
	 * after the fact. */
	console.warn(
		"[migrate-field-schema] DEPLOY ORDER: run this BEFORE deploying the\n" +
			"  schema-enforcing app. Reverse order breaks loads of any app\n" +
			"  whose blueprint contains a repeat field, AND silently drops\n" +
			"  the case-type pointer on every field still carrying the\n" +
			"  legacy `case_property` key.",
	);

	const db = getDb();
	/* Raw collection read — skip `collections.apps()` (which applies the
	 * Zod converter). Pre-migration docs would fail that converter on
	 * the very fields we're trying to fix. */
	const apps = await db.collection("apps").get();
	let scannedApps = 0;
	let scannedFields = 0;
	let scannedRepeats = 0;
	let updatedRepeats = 0;
	let updatedCaseProperty = 0;
	let updatedApps = 0;

	for (const app of apps.docs) {
		scannedApps++;
		const data = app.data() as {
			blueprint?: { fields?: Record<string, LegacyField> };
		};
		const fields = data.blueprint?.fields;
		if (!fields) continue;

		/* Per-app update map — one Firestore `.update()` per app, with
		 * dot-path keys so each affected slot is written in isolation.
		 * The rest of the blueprint (every non-affected field, every
		 * field already migrated) stays untouched. */
		const updates: Record<string, unknown> = {};
		for (const [uuid, field] of Object.entries(fields)) {
			if (!field) continue;
			scannedFields++;

			/* Migration 1 — repeat_mode backfill. Idempotent: any
			 * defined value (including the value the SA already
			 * produces under the new schema) is respected. */
			if (field.kind === "repeat") {
				scannedRepeats++;
				if (field.repeat_mode === undefined) {
					updates[`blueprint.fields.${uuid}.repeat_mode`] = "user_controlled";
					updatedRepeats++;
				}
			}

			/* Migration 2 — case_property → case_property_on rename.
			 * Two-step within the single batched update:
			 *   - write the new key with the legacy value
			 *   - delete the legacy key (Firestore `FieldValue.delete()`)
			 * Idempotency: skip the rename when the legacy key is
			 * absent OR when the new key is already populated (latter
			 * defends against a partially-migrated field where the
			 * legacy key wasn't deleted). */
			const hasLegacy = typeof field.case_property === "string";
			const hasNew = typeof field.case_property_on === "string";
			if (hasLegacy && !hasNew) {
				updates[`blueprint.fields.${uuid}.case_property_on`] =
					field.case_property;
				updates[`blueprint.fields.${uuid}.case_property`] = FieldValue.delete();
				updatedCaseProperty++;
			} else if (hasLegacy && hasNew) {
				/* Defensive cleanup — both keys present means a prior
				 * partial run wrote the new key without deleting the
				 * legacy one. The expected partial-failure shape leaves
				 * both values equal; loud-fail on divergence so an
				 * operator sees unexpected state instead of silently
				 * picking a winner. The new key stays authoritative
				 * either way; the legacy key is always removed. */
				if (field.case_property !== field.case_property_on) {
					log.warn(
						`[migrate-field-schema] divergent case_property pointers on app=${app.id} field=${uuid}: ` +
							`legacy=${JSON.stringify(field.case_property)} new=${JSON.stringify(field.case_property_on)}. ` +
							`Keeping new; dropping legacy. Investigate before treating this app as migrated.`,
					);
				}
				updates[`blueprint.fields.${uuid}.case_property`] = FieldValue.delete();
				updatedCaseProperty++;
			}
		}
		if (Object.keys(updates).length === 0) continue;
		if (!dryRun) {
			await app.ref.update(updates);
		}
		updatedApps++;
	}

	log.info(
		`[migrate-field-schema] scannedApps=${scannedApps} scannedFields=${scannedFields} scannedRepeats=${scannedRepeats} updatedApps=${updatedApps} updatedRepeats=${updatedRepeats} updatedCaseProperty=${updatedCaseProperty} dryRun=${dryRun}`,
	);
}

if (process.argv.includes("--help") || process.argv.includes("-h")) {
	console.log(
		[
			"migrate-field-schema — backfill blueprint-field schema migrations.",
			"",
			"Two migrations are applied per field:",
			"  1. repeat_mode default for legacy repeats (user_controlled).",
			"  2. case_property → case_property_on rename.",
			"",
			"Usage:",
			"  npx tsx scripts/migrate-field-schema.ts --dry-run   count only",
			"  npx tsx scripts/migrate-field-schema.ts             actually write",
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
