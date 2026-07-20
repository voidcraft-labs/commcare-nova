/**
 * Classify property-surface changes between two blueprint snapshots.
 *
 * The cross-store saga (`applyBlueprintChange`) compares the doc's
 * prior state against the prospective new state and routes each
 * affected `(caseType, property)` pair through the case store's
 * `applySchemaChange` interface. This module owns the diff logic.
 *
 * The output of the classifier is an array of "schema-affecting
 * change entries" — one entry per `applySchemaChange` call the saga
 * must issue. Three flavors:
 *
 *   1. **Schema-sync-only** — `{ caseType, property: undefined,
 *      change: undefined }`. Issued for any case-type whose property
 *      surface changed in a way that doesn't require per-row
 *      migration: property add, option add, property remove, or any
 *      mutation to a property's `label` / `hint` / `validation`
 *      slots. The case-store regenerates the JSON Schema and emits
 *      the index DDL diff; existing rows pass the new schema as-is.
 *
 *   2. **Per-row migration** — `{ caseType, property, change }` with
 *      a discriminated `change` shape. Issued when the property's
 *      `data_type` shifted (`retype`), the property was renamed
 *      (`rename`), or a `single_select` / `multi_select` option set
 *      narrowed (`narrow-options`). The case-store runs the schema
 *      sync + per-row migration in one transaction; rows that fail
 *      the new schema move to `cases_quarantine`.
 *
 *   3. **Empty result** — pure non-case-type mutations (module name
 *      edits, form text edits, field UI tweaks) yield no entries.
 *      The saga skips `applySchemaChange` entirely and just commits
 *      the blueprint write.
 *
 * Case-type removals between snapshots produce no entry. Existing
 * rows keep their values in JSONB — nothing rewrites or strips
 * them; the case-store's `case_type_schemas` row stays in place
 * (still admitting those values) because the runtime never reads
 * a schema for a case type the blueprint no longer references, so
 * the orphaned row is harmless.
 *
 * Case-type additions produce one schema-sync-only entry so the
 * `case_type_schemas` row materializes the moment the blueprint
 * commits — without it, the first insert against the new case
 * type would fail the schema lookup with `SchemaNotSyncedError`.
 *
 * Rename detection vs. add+remove ambiguity: a rename and an
 * "add new + remove old" pair look identical at the property-list
 * level. The classifier does NOT attempt to detect renames
 * heuristically; rename entries are emitted only when the caller
 * supplies a `rename` hint. Without the hint, the classifier
 * treats any property whose name changes shape as a remove + add
 * pair (one schema-sync-only entry per change). Callers that need
 * rename semantics pass an explicit `rename` hint to
 * `applyBlueprintChange`.
 *
 * `narrow-options` similarly requires explicit intent: shrinking an
 * option set looks identical to removing the property. The
 * classifier doesn't synthesize narrow-options entries from option-
 * list diffs alone; callers thread the discriminated change shape
 * through the `narrow-options` hint when they intend per-row
 * migration semantics.
 */

import type { SchemaChangeKind } from "@/lib/case-store";
import {
	type BlueprintDoc,
	type CaseProperty,
	type CaseType,
	materializableCaseTypes,
} from "@/lib/domain";

/**
 * One change entry the saga issues to the case store. Mirrors the
 * `ApplySchemaChangeArgs` shape minus the `appId` and `blueprint`
 * fields (the saga supplies those uniformly across the loop).
 */
export interface CaseTypeChangeEntry {
	readonly caseType: string;
	readonly property?: string;
	readonly change?: SchemaChangeKind;
}

/**
 * Optional explicit intent the caller can supply alongside a
 * blueprint change. The classifier uses these hints to emit the
 * matching `change` shape rather than synthesizing the per-row
 * migration from the property-list diff alone.
 *
 * Only one hint is consumed per classifier run — the saga's
 * single-blueprint-mutation contract assumes one user-driven edit
 * per call. Multi-step refactors (rename + retype on the same
 * property) split into two saga calls.
 */
export type SchemaChangeHint =
	| {
			readonly kind: "rename";
			readonly caseType: string;
			readonly from: string;
			readonly to: string;
	  }
	| {
			readonly kind: "retype";
			readonly caseType: string;
			readonly property: string;
			readonly fromType: NonNullable<CaseProperty["data_type"]>;
			readonly toType: NonNullable<CaseProperty["data_type"]>;
	  }
	| {
			readonly kind: "narrow-options";
			readonly caseType: string;
			readonly property: string;
			readonly removedOptions: readonly string[];
	  };

/**
 * Input shape for `classifyCaseTypeChanges`. Exposed as a typed
 * record so tests and call sites can construct fixture inputs
 * without depending on the full `BlueprintDoc` shape.
 */
export interface ClassifyArgs {
	readonly prior: BlueprintDoc;
	readonly prospective: BlueprintDoc;
	readonly hint?: SchemaChangeHint;
}

/**
 * Compute the schema-affecting change set between two blueprint
 * snapshots. Returns an empty array when no case-type property
 * surface differs.
 *
 * Strategy:
 *   1. If a hint is supplied, emit its discriminated `change`
 *      entry first. The hint encodes the per-row migration the
 *      blueprint author intended; the case-store runs it
 *      alongside the schema regen in one transaction.
 *   2. Walk the prospective case types. For each case type
 *      present in both snapshots, diff the property lists. Any
 *      structural change (property added/removed, `data_type`
 *      shifted) yields one schema-sync-only entry per affected
 *      case type. The hint already covers the per-row work for
 *      the hint-targeted case type; the schema-sync entry is
 *      skipped to avoid issuing a redundant `applySchemaChange`
 *      for the same case type.
 *   3. Walk the prospective case types looking for additions
 *      (case types not present in `prior`). One schema-sync entry
 *      per added case type so `case_type_schemas` populates.
 *   4. Case-type removals are intentionally NOT emitted — see the
 *      module-level docblock for the orphan-row rationale.
 */
export function classifyCaseTypeChanges(
	args: ClassifyArgs,
): readonly CaseTypeChangeEntry[] {
	// Diff the MATERIALIZABLE views, not the raw catalogs — the schema
	// rows the saga writes are built from that view
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

	// Track which case types were already covered by the hint so the
	// per-property diff loop doesn't enqueue a redundant schema-sync
	// entry for the same case type. The hint's `applySchemaChange`
	// call already runs the schema regen alongside the per-row
	// migration.
	const caseTypesCoveredByHint = new Set<string>();

	if (args.hint !== undefined) {
		entries.push(entryFromHint(args.hint));
		caseTypesCoveredByHint.add(args.hint.caseType);
	}

	for (const [name, prospectiveType] of prospectiveByName) {
		if (caseTypesCoveredByHint.has(name)) continue;

		const priorType = priorByName.get(name);
		if (priorType === undefined) {
			// Case-type addition — schema-sync-only entry materializes
			// the `case_type_schemas` row before the first insert.
			entries.push({ caseType: name });
			continue;
		}

		if (caseTypePropertySurfaceDiffers(priorType, prospectiveType)) {
			// Property surface shifted — schema-sync-only entry
			// regenerates the JSON Schema + diffs the index set.
			entries.push({ caseType: name });
		}
	}

	return entries;
}

/**
 * Translate a caller-supplied hint into the matching schema-change
 * entry. Pure helper; the `change` shape mirrors
 * `SchemaChangeKind`'s discriminated union arm-for-arm.
 */
function entryFromHint(hint: SchemaChangeHint): CaseTypeChangeEntry {
	switch (hint.kind) {
		case "rename":
			return {
				caseType: hint.caseType,
				property: hint.to,
				change: { kind: "rename", from: hint.from, to: hint.to },
			};
		case "retype":
			return {
				caseType: hint.caseType,
				property: hint.property,
				change: {
					kind: "retype",
					fromType: hint.fromType,
					toType: hint.toType,
				},
			};
		case "narrow-options":
			return {
				caseType: hint.caseType,
				property: hint.property,
				change: {
					kind: "narrow-options",
					removedOptions: [...hint.removedOptions],
				},
			};
	}
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
 * re-sync is cheap, and every extra trigger is an opportunistic
 * convergence hook — a stored row written by an OLDER generator (e.g.
 * a legacy option-value enum) converges to the current derivation the
 * next time anything on its case type is touched, without waiting for
 * the drift scripts.
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
	if (a.name !== b.name) return true;
	if (a.data_type !== b.data_type) return true;
	if (a.label !== b.label) return true;
	if (a.hint !== b.hint) return true;
	if (a.required !== b.required) return true;
	if (a.validation !== b.validation) return true;
	if (a.validation_msg !== b.validation_msg) return true;
	return optionsDiffer(a.options, b.options);
}

/**
 * Compare two option lists by value+label tuple in order. Options
 * never reach the emitted JSON Schema (select values validate as
 * plain strings), so any option edit — including a pure reorder —
 * triggers only the cheap opportunistic re-sync described on
 * `caseTypePropertySurfaceDiffers`.
 */
function optionsDiffer(
	a: CaseProperty["options"],
	b: CaseProperty["options"],
): boolean {
	if (a === undefined && b === undefined) return false;
	if (a === undefined || b === undefined) return true;
	if (a.length !== b.length) return true;
	for (let i = 0; i < a.length; i++) {
		const oa = a[i];
		const ob = b[i];
		if (oa === undefined || ob === undefined) return true;
		if (oa.value !== ob.value) return true;
		if (oa.label !== ob.label) return true;
	}
	return false;
}
