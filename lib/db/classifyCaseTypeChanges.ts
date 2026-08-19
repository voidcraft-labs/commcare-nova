/**
 * Classify property-surface changes between two blueprint snapshots.
 *
 * `applyBlueprintChange` calls this from the guarded writer's `beforeWrite`
 * hook with the freshly locked prior and admitted candidate. Each affected
 * case type is then derived from the committed candidate after commit.
 *
 * The output is one lifecycle entry per affected case type. It carries no
 * rename inference and no caller-intent row migration:
 *
 *   1. **Schema sync** — `{ kind: "sync", caseType }`. Issued for any case type whose property
 *      surface changed in a way that carries no provable per-row
 *      migration: property add, option add, property remove, a
 *      `data_type` shift, or any mutation to a property's `label` /
 *      `hint` / `validation` slots. The case-store regenerates the
 *      JSON Schema and emits the index DDL diff; its own
 *      string↔array reshape may still rewrite flipped select rows
 *      inside the sync.
 *
 *   2. **Schema retirement** — `{ kind: "retire", caseType }`. Issued when a
 *      materializable case type disappears. Retained case rows are untouched;
 *      the guarded commit atomically marks the durable schema inactive and
 *      queues its expression indexes for removal.
 *
 *   3. **Empty result** — pure non-case-type mutations (module name
 *      edits, form text edits, field UI tweaks) yield no entries.
 *      No case-schema store is opened.
 *
 * Case-type retirement never deletes existing rows or their JSONB values. The
 * inactive schema retains its last validation contract for safe reactivation,
 * but ordinary runtime validation treats it as absent. A property removal on a LIVE case
 * type is schema-sync-only: rows keep the orphaned values, and the
 * store sheds them on each row's next properties write (the
 * merged-update strip in `PostgresCaseStore.update`).
 *
 * Case-type additions produce one schema-sync-only entry so the
 * `case_type_schemas` row materializes the moment the blueprint
 * commits — without it, the first insert against the new case
 * type would fail the schema lookup with `SchemaNotSyncedError`.
 *
 * Property renames are never inferred from snapshot differences. The explicit,
 * batch-exclusive `renameCaseProperties` mutation carries that intent and its
 * dedicated transaction rewrites schema, live rows, parked rows, Blueprint,
 * and accepted history together. A generic diff cannot distinguish rename
 * from remove-plus-add and therefore has no authority to relocate data.
 */

import { deepEqual } from "@/lib/doc/deepEqual";
import {
	type BlueprintDoc,
	type CaseProperty,
	type CaseType,
	materializableCaseTypes,
	USERCASE_CASE_TYPE,
	usercaseCaseType,
} from "@/lib/domain";

/**
 * One case type whose derived schema must converge after commit.
 */
export type CaseTypeChangeEntry =
	| { readonly kind: "sync"; readonly caseType: string }
	| { readonly kind: "retire"; readonly caseType: string };

/**
 * Input shape for `classifyCaseTypeChanges`. Exposed as a typed
 * record so tests and call sites can construct fixture inputs
 * without depending on the full `BlueprintDoc` shape.
 */
export interface ClassifyArgs {
	readonly prior: BlueprintDoc;
	readonly prospective: BlueprintDoc;
}

/**
 * Compute the schema-affecting change set between two blueprint
 * snapshots. Returns an empty array when no case-type property
 * surface differs.
 *
 * Strategy:
 *   1. Walk the prospective case types. For each case type
 *      present in both snapshots, diff the property lists. Any
 *      structural change (property added/removed, `data_type`
 *      shifted) yields one schema-sync-only entry per affected case type.
 *   2. Walk the prospective case types looking for additions
 *      (case types not present in `prior`). One schema-sync entry
 *      per added case type so `case_type_schemas` populates.
 *   3. Walk the prior case types for removals. Emit one retirement entry for
 *      each name absent from the prospective materializable catalog.
 */
export function classifyCaseTypeChanges(
	args: ClassifyArgs,
): readonly CaseTypeChangeEntry[] {
	// Diff the MATERIALIZABLE views, not the raw catalogs — the schema
	// rows the post-commit materializer writes are built from that view
	// (`buildCaseTypeMap`), so the diff must see exactly
	// what the rows will hold. Concretely: converting a writer field's
	// kind (or editing a hidden writer's expression) changes a
	// property's DERIVED `data_type` without touching `doc.caseTypes`;
	// a raw-catalog diff would skip the schema re-sync and leave
	// `case_type_schemas` stale against the compiler's view.
	const priorByName = indexCaseTypes(materializableCaseTypes(args.prior));
	const prospectiveByName = indexCaseTypes(
		materializableCaseTypes(args.prospective),
	);

	const entries: CaseTypeChangeEntry[] = [];

	for (const [name, prospectiveType] of prospectiveByName) {
		const priorType = priorByName.get(name);
		if (priorType === undefined) {
			// Case-type addition — schema-sync-only entry materializes
			// the `case_type_schemas` row before the first insert.
			entries.push({ kind: "sync", caseType: name });
			continue;
		}

		if (caseTypePropertySurfaceDiffers(priorType, prospectiveType)) {
			// Property surface shifted — schema-sync-only entry
			// regenerates the JSON Schema + diffs the index set.
			entries.push({ kind: "sync", caseType: name });
		}
	}

	for (const name of priorByName.keys()) {
		if (!prospectiveByName.has(name)) {
			entries.push({ kind: "retire", caseType: name });
		}
	}

	// The worker's own case is compared SEPARATELY because it is derived from
	// the worker-property catalog rather than declared, so it is absent from
	// `materializableCaseTypes` by design (it is storable, not authorable) and
	// the loops above can never see it. Without this an author adding a worker
	// property gets no schema sync, and the next usercase write is refused by a
	// stale case type with `additionalProperties` — the failure looking like a
	// bug in the write rather than in the sync that never ran.
	//
	// No retire arm: every app has a usercase, so it is added and re-synced but
	// never removed.
	if (
		caseTypePropertySurfaceDiffers(
			usercaseCaseType(args.prior),
			usercaseCaseType(args.prospective),
		)
	) {
		entries.push({ kind: "sync", caseType: USERCASE_CASE_TYPE });
	}

	return entries;
}

/**
 * Build a name → CaseType map for fast lookup over the effective
 * view (an empty blueprint yields an empty map), mirroring
 * `buildCaseTypeMap` from `lib/case-store/store.ts`.
 */
function indexCaseTypes(
	caseTypes: readonly CaseType[],
): ReadonlyMap<string, CaseType> {
	const map = new Map<string, CaseType>();
	for (const ct of caseTypes) {
		map.set(ct.name, ct);
	}
	return map;
}

/**
 * Compare two case-type snapshots by their property surface. Returns
 * `true` iff the property list has shifted — name, `data_type`,
 * `required` flag, validation pattern, label/hint, or option set.
 *
 * Deliberately WIDER than what the emitted JSON Schema reads (options
 * never reach it, and label/hint only feed title/description): a
 * re-sync is cheap and keeps every derived schema/index projection current.
 */
function caseTypePropertySurfaceDiffers(
	prior: CaseType,
	prospective: CaseType,
): boolean {
	if (prior.parent_type !== prospective.parent_type) return true;
	if (prior.relationship !== prospective.relationship) return true;
	if (prior.properties.length !== prospective.properties.length) return true;
	for (let i = 0; i < prior.properties.length; i++) {
		const a = prior.properties[i];
		const b = prospective.properties[i];
		// `length` check above guarantees both indices resolve, but
		// TypeScript can't prove it; the explicit narrow keeps the
		// per-field reads sound without resorting to `!`.
		if (a === undefined || b === undefined) return true;
		if (propertyDiffers(a, b)) return true;
	}
	return false;
}

/**
 * Compare two `CaseProperty` snapshots field-by-field. Cheap
 * structural equality — every slot the JSON Schema generator
 * embeds is compared verbatim.
 */
function propertyDiffers(a: CaseProperty, b: CaseProperty): boolean {
	return !deepEqual(a, b);
}
