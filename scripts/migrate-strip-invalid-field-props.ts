/**
 * One-off migration: strip field-kind properties the realigned schemas no
 * longer declare.
 *
 * Two realignments motivate this, and both must land in stored data before
 * the narrowed schema deploys:
 *
 *   1. `calculate` now lives ONLY on `hidden` fields. On a visible control a
 *      `calculate` is the read-only-but-looks-editable footgun (Vellum's
 *      `visible_if_present` legacy case): the user sees an editable input
 *      whose value is silently overwritten by the recompute. Stripping it
 *      leaves the field as an ordinary user-entered input — a semantic
 *      change (computed → user-entered), never structural, so nothing that
 *      referenced the node dangles.
 *   2. `required` is no longer allowed on `hidden` fields. A hidden field is
 *      never shown, so the user can't fill it — if its computed / default
 *      value ever resolves empty while required, the form is unsubmittable
 *      with no visible input to remedy. CommCare's authoring model forbids
 *      it too: Vellum's DataBindOnly sets `requiredAttr: notallowed`.
 *      Stripping it only drops a constraint; the field's value is untouched,
 *      so nothing that read the node changes.
 *
 * After both realignments the per-kind schemas are `.strict()` and don't
 * declare these keys, so the app-doc Firestore converter — which runs a
 * THROWING `blueprintDocSchema.parse()` on read — would reject any stored
 * app still carrying them, 503-ing the whole app. This script removes the
 * stale keys so those apps parse cleanly under the new schema.
 *
 * ──────────────────────────────────────────────────────────────────────
 * DEPLOY ORDER (load-bearing — read before running):
 *   1. Run this `--apply` against PRODUCTION Firestore.
 *   2. Confirm a re-run reports zero remaining strip targets.
 *   3. ONLY THEN merge / deploy the narrowed field-kind schemas.
 *
 * The reverse order is a live outage: the moment the narrowed (strict)
 * schema serves reads, the app-doc converter's `.parse()` throws on every
 * stored app that still carries one of these stale keys, and those apps
 * fail to load (503) until this migration has run. The migration itself
 * reads RAW Firestore JSON (no converter), so it is safe to run in any
 * order — it is the deploy that must wait for it.
 * ──────────────────────────────────────────────────────────────────────
 *
 * Idempotent: a field with no stale key is skipped, so re-runs converge to
 * zero. Default is dry-run (report only); pass `--apply` to write.
 *
 * Usage:
 *   npx tsx scripts/migrate-strip-invalid-field-props.ts            # dry-run
 *   npx tsx scripts/migrate-strip-invalid-field-props.ts --apply    # write
 */

import "dotenv/config";
import { FieldPath, FieldValue } from "@google-cloud/firestore";
import { getDb } from "@/lib/db/firestore";
import { log } from "@/lib/logger";

/**
 * The visible-input kinds. A `calculate` on any of these is the footgun
 * being removed; on every other kind `calculate` is either legitimate
 * (`hidden`) or was never on the schema. Kept as a literal (not derived
 * from the domain registry) because the registry is mid-realignment — the
 * migration must classify by the PRE-change shape, which this fixed list
 * captures.
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

/**
 * One strip rule = one (key, applies-to-kind) pair the narrowed schema now
 * rejects. The migration deletes `key` from every field whose `kind` the
 * predicate accepts and that carries the key as an own property. `note`
 * frames the semantic blast radius for the dry-run report.
 */
type StripRule = {
	key: string;
	appliesTo: (kind: string) => boolean;
	note: string;
};

const STRIP_RULES: StripRule[] = [
	{
		key: "calculate",
		appliesTo: (kind) => VISIBLE_INPUT_KINDS.has(kind),
		note: "computed value removed — the field is now an ordinary user-entered input",
	},
	{
		key: "required",
		appliesTo: (kind) => kind === "hidden",
		note: "required removed — a hidden field is never shown, so it can't be required",
	},
];

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
	case_property_on?: unknown;
} & Record<string, unknown>;

/** A field with the specific keys this migration will delete from it. */
type StripTarget = { uuid: string; field: RawField; keys: string[] };

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
 * operator sees that the field still feeds those expressions (they still
 * resolve; a stripped `calculate` just means the node is now user-entered).
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

/**
 * Which keys does this field carry that a strip rule now forbids? Keys are
 * collected on PRESENCE (`Object.hasOwn`), not on a non-empty value: the
 * narrowed schema is `.strict()`, which rejects on the mere presence of an
 * undeclared key regardless of its value. A historical `calculate: ""` /
 * `required: null` would slip a value-based predicate yet still 503 under
 * the strict schema — and the re-run-to-zero deploy gate would be blind to
 * it. Keying on `Object.hasOwn` aligns the strip, the dry-run count, and the
 * gate with the exact thing `.strict()` rejects. `FieldValue.delete()` is a
 * no-op on an absent key, so this can only under-strip, never over-delete.
 */
function staleKeysFor(field: RawField): string[] {
	if (typeof field.kind !== "string") return [];
	const kind = field.kind;
	return STRIP_RULES.filter(
		(rule) => rule.appliesTo(kind) && Object.hasOwn(field, rule.key),
	).map((rule) => rule.key);
}

async function run(apply: boolean): Promise<void> {
	// Print the deploy-order warning on every invocation (dry-run AND
	// --apply) — the hazard is operational, surfaced before any traffic.
	console.warn(
		"[strip-invalid-field-props] DEPLOY ORDER: run --apply on prod BEFORE\n" +
			"  deploying the narrowed field-kind schemas. The narrowed strict\n" +
			"  schema 503s any app still carrying a stripped key (visible\n" +
			"  `calculate` or hidden `required`).",
	);

	const db = getDb();
	// Raw read — no `.withConverter`, so the strict blueprint schema never
	// runs. This is the whole reason the migration can run before the
	// schema change deploys.
	const apps = await db.collection("apps").get();

	let appsAffected = 0;
	let fieldsStripped = 0;
	// Per-key totals so the summary line proves both realignments were
	// covered, not just whichever happened to have data.
	const keyTotals = new Map<string, number>(
		STRIP_RULES.map((rule) => [rule.key, 0]),
	);

	for (const app of apps.docs) {
		const data = app.data() as {
			blueprint?: { fields?: Record<string, RawField> };
		};
		const fields = data.blueprint?.fields;
		if (!fields) continue;

		// Gather this app's strip targets first, so the per-app update is one
		// batched write and the report groups by app.
		const targets: StripTarget[] = [];
		for (const [uuid, field] of Object.entries(fields)) {
			if (!field) continue;
			const keys = staleKeysFor(field);
			if (keys.length > 0) targets.push({ uuid, field, keys });
		}
		if (targets.length === 0) continue;

		appsAffected++;
		console.log(`\napp ${app.id} — ${targets.length} field(s):`);
		for (const { uuid, field, keys } of targets) {
			const caseProp =
				typeof field.case_property_on === "string"
					? field.case_property_on
					: null;
			console.log(
				`  • ${field.id} (kind=${field.kind}) strip [${keys.join(", ")}]`,
			);
			// Per-rule semantic note for each stripped key.
			for (const key of keys) {
				const rule = STRIP_RULES.find((r) => r.key === key);
				if (rule) console.log(`      ↳ ${rule.note}`);
				keyTotals.set(key, (keyTotals.get(key) ?? 0) + 1);
			}
			// Blast radius the operator should see before --apply, shown only
			// when a `calculate` is among the stripped keys (that's the change
			// that flips a node from computed to user-entered; a stripped
			// `required` leaves the value untouched, so readers are unaffected).
			if (keys.includes("calculate")) {
				if (caseProp)
					console.log(
						`      ↳ writes case property on "${caseProp}" — now user-entered, not computed`,
					);
				const referrers = findReferrers(fields, uuid, field.id ?? "");
				if (referrers.length)
					console.log(`      ↳ referenced by: ${referrers.join(", ")}`);
			}
			fieldsStripped++;
		}

		if (apply) {
			// One update per app: a FieldValue.delete() per (target, stale key),
			// plus the standard `updated_at` advance. FieldPath (not a dotted
			// string) so a uuid can never be misread as a path.
			const updateArgs: unknown[] = [];
			for (const { uuid, keys } of targets) {
				for (const key of keys) {
					updateArgs.push(
						new FieldPath("blueprint", "fields", uuid, key),
						FieldValue.delete(),
					);
				}
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

	const perKey = STRIP_RULES.map(
		(rule) => `${rule.key}=${keyTotals.get(rule.key)}`,
	).join(" ");
	log.info(
		`[strip-invalid-field-props] appsAffected=${appsAffected} fieldsStripped=${fieldsStripped} (${perKey}) ${apply ? "APPLIED" : "(dry-run — pass --apply to write)"}`,
	);
}

run(process.argv.includes("--apply")).catch((err) => {
	console.error(err);
	process.exit(1);
});
