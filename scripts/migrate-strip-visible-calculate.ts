/**
 * One-off migration: strip `calculate` from VISIBLE-input fields.
 *
 * Context. The field-kind schemas are being realigned so that a
 * `calculate` bind lives only on `hidden` fields. On a visible control a
 * `calculate` is the read-only-but-looks-editable footgun (Vellum's
 * `visible_if_present` legacy case): the user sees an editable input whose
 * value is silently overwritten by the recompute. After the realignment,
 * the per-kind schemas are `.strict()` and no longer declare `calculate`
 * on the visible kinds, so the app-doc Firestore converter — which runs a
 * THROWING `blueprintDocSchema.parse()` on read — would reject any stored
 * app that still carries the old shape, 503-ing the whole app.
 *
 * This script removes the stale `calculate` from every visible field so
 * those apps parse cleanly under the new schema. The stripped field stays
 * in place as an ordinary user-entered input — the change is semantic
 * (computed → user-entered), never structural, so nothing that referenced
 * the field's node dangles.
 *
 * Visible-input kinds (the only kinds whose schema ever carried
 * `calculate` AND rendered an editable control): text / int / decimal /
 * date / time / datetime / single_select / multi_select / geopoint /
 * barcode. `hidden` keeps its `calculate` and is never touched. The other
 * kinds (group / repeat / label / media / secret) never declared
 * `calculate`, so there is nothing to strip.
 *
 * ──────────────────────────────────────────────────────────────────────
 * DEPLOY ORDER (load-bearing — read before running):
 *   1. Run this `--apply` against PRODUCTION Firestore.
 *   2. Confirm a re-run reports zero remaining strip targets.
 *   3. ONLY THEN merge / deploy the narrowed field-kind schemas.
 *
 * The reverse order is a live outage: the moment the narrowed (strict)
 * schema serves reads, the app-doc converter's `.parse()` throws on every
 * stored app that still carries visible `calculate`, and those apps fail
 * to load (503) until this migration has run. The migration itself reads
 * RAW Firestore JSON (no converter), so it is safe to run in any order —
 * it is the deploy that must wait for it.
 * ──────────────────────────────────────────────────────────────────────
 *
 * Idempotent: a field with no `calculate` is skipped, so re-runs converge
 * to zero. Default is dry-run (report only); pass `--apply` to write.
 *
 * Usage:
 *   npx tsx scripts/migrate-strip-visible-calculate.ts            # dry-run
 *   npx tsx scripts/migrate-strip-visible-calculate.ts --apply    # write
 */

import "dotenv/config";
import { FieldPath, FieldValue } from "@google-cloud/firestore";
import { getDb } from "@/lib/db/firestore";
import { log } from "@/lib/logger";

/**
 * The visible-input kinds. A `calculate` on any of these is the footgun
 * being removed; on every other kind `calculate` is either legitimate
 * (`hidden`) or was never on the schema, so this set is the exhaustive
 * strip target. Kept as a literal (not derived from the domain registry)
 * because the registry is mid-realignment — the migration must classify
 * by the PRE-change shape, which this fixed list captures.
 */
const VISIBLE_INPUT_KINDS = new Set([
	"text",
	"int",
	"decimal",
	"date",
	"time",
	"datetime",
	"single_select",
	"multi_select",
	"geopoint",
	"barcode",
]);

/** XPath-valued field keys that could reference another field's node. */
const XPATH_KEYS = [
	"calculate",
	"relevant",
	"required",
	"default_value",
	"validate", // domain stores `validate` as a string (the constraint XPath)
] as const;

/** A raw (un-Zod-parsed) stored field. */
type RawField = {
	id?: string;
	kind?: string;
	calculate?: unknown;
	case_property_on?: unknown;
} & Record<string, unknown>;

/**
 * Escape a semantic field id for use inside a RegExp, then match it as a
 * standalone token (not a substring of a longer identifier) so the
 * reference report doesn't false-positive on `age` inside `age_years`.
 */
function referencesId(haystack: string, id: string): boolean {
	const escaped = id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	return new RegExp(`(^|[^A-Za-z0-9_])${escaped}([^A-Za-z0-9_]|$)`).test(
		haystack,
	);
}

/**
 * Find the ids of other fields in the same app whose XPath surfaces
 * reference the stripped field's node — surfaced in the dry-run so the
 * operator sees that removing the computed value leaves a now-user-entered
 * input feeding those expressions (still resolves; just no longer
 * auto-computed).
 */
function findReferrers(
	fields: Record<string, RawField>,
	targetUuid: string,
	targetId: string,
): string[] {
	// An absent id would make the token regex match nearly any XPath string,
	// reporting every field as a referrer. `id` is schema-required so this is
	// defensive, but cheap.
	if (!targetId) return [];
	const referrers: string[] = [];
	for (const [uuid, f] of Object.entries(fields)) {
		if (uuid === targetUuid || !f) continue;
		for (const key of XPATH_KEYS) {
			const v = f[key];
			if (typeof v === "string" && referencesId(v, targetId)) {
				referrers.push(f.id ?? uuid);
				break;
			}
		}
	}
	return referrers;
}

async function run(apply: boolean): Promise<void> {
	// Print the deploy-order warning on every invocation (dry-run AND
	// --apply) — the hazard is operational, surfaced before any traffic.
	console.warn(
		"[strip-visible-calculate] DEPLOY ORDER: run --apply on prod BEFORE\n" +
			"  deploying the narrowed field-kind schemas. The narrowed strict\n" +
			"  schema 503s any app still carrying visible `calculate`.",
	);

	const db = getDb();
	// Raw read — no `.withConverter`, so the strict blueprint schema never
	// runs. This is the whole reason the migration can run before the
	// schema change deploys.
	const apps = await db.collection("apps").get();

	let appsAffected = 0;
	let fieldsStripped = 0;

	for (const app of apps.docs) {
		const data = app.data() as {
			blueprint?: { fields?: Record<string, RawField> };
		};
		const fields = data.blueprint?.fields;
		if (!fields) continue;

		// Gather this app's strip targets first, so the per-app update is one
		// batched write and the report groups by app.
		const targets: Array<{ uuid: string; field: RawField }> = [];
		for (const [uuid, field] of Object.entries(fields)) {
			if (!field) continue;
			// Strip on KEY PRESENCE, not on a non-empty string value: the
			// narrowed schema is `.strict()`, which rejects on the mere
			// presence of an undeclared key regardless of its value. A
			// historical `calculate: ""` / `calculate: null` would slip a
			// value-based predicate yet still 503 under the strict schema —
			// and the re-run-to-zero deploy gate would be blind to it. Keying
			// on `Object.hasOwn` aligns the strip, the dry-run count, and the
			// gate with the exact thing `.strict()` rejects. `FieldValue.delete()`
			// is a no-op on an absent key, so this can only under-strip, never
			// over-delete.
			if (
				typeof field.kind === "string" &&
				VISIBLE_INPUT_KINDS.has(field.kind) &&
				Object.hasOwn(field, "calculate")
			) {
				targets.push({ uuid, field });
			}
		}
		if (targets.length === 0) continue;

		appsAffected++;
		console.log(`\napp ${app.id} — ${targets.length} field(s):`);
		for (const { uuid, field } of targets) {
			const referrers = findReferrers(fields, uuid, field.id ?? "");
			const caseProp =
				typeof field.case_property_on === "string"
					? field.case_property_on
					: null;
			console.log(
				`  • ${field.id} (kind=${field.kind}) calc=${JSON.stringify(field.calculate).slice(0, 60)}`,
			);
			// Semantic blast radius the operator should see before --apply:
			// (a) the case property now stores user input instead of the
			// computed value; (b) any field that referenced this node now
			// reads a user-entered value (still resolves — no dangle).
			if (caseProp)
				console.log(
					`      ↳ writes case property on "${caseProp}" — now user-entered, not computed`,
				);
			if (referrers.length)
				console.log(`      ↳ referenced by: ${referrers.join(", ")}`);
			fieldsStripped++;
		}

		if (apply) {
			// One update per app: a FieldValue.delete() per target's nested
			// `calculate`, plus the standard `updated_at` advance. FieldPath
			// (not a dotted string) so a uuid can never be misread as a path.
			const updateArgs: unknown[] = [];
			for (const { uuid } of targets) {
				updateArgs.push(
					new FieldPath("blueprint", "fields", uuid, "calculate"),
					FieldValue.delete(),
				);
			}
			updateArgs.push(
				new FieldPath("updated_at"),
				FieldValue.serverTimestamp(),
			);
			// `update`'s varargs overload: (field, value, field, value, …).
			await (app.ref.update as (...a: unknown[]) => Promise<unknown>)(
				...updateArgs,
			);
		}
	}

	log.info(
		`[strip-visible-calculate] appsAffected=${appsAffected} fieldsStripped=${fieldsStripped} ${apply ? "APPLIED" : "(dry-run — pass --apply to write)"}`,
	);
}

run(process.argv.includes("--apply")).catch((err) => {
	console.error(err);
	process.exit(1);
});
