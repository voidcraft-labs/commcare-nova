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
 *      surface changed in a way that carries no provable per-row
 *      migration: property add, option add, property remove, a
 *      `data_type` shift, or any mutation to a property's `label` /
 *      `hint` / `validation` slots. The case-store regenerates the
 *      JSON Schema and emits the index DDL diff; its own
 *      string↔array reshape may still rewrite flipped select rows
 *      inside the sync.
 *
 *   2. **Per-row migration** — `{ caseType, property, change }` with
 *      a discriminated `change` shape. Issued for a PROVEN rename
 *      (see below). The case-store runs the schema sync + per-row
 *      migration in one transaction; rows whose value cannot live
 *      under the destination declaration move to `cases_quarantine`.
 *      (`SchemaChangeKind`'s other arms — `retype`,
 *      `narrow-options` — are never classifier-emitted; the drift
 *      scripts drive them against `applySchemaChange` directly.)
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
 * the orphaned row is harmless. A property removal on a LIVE case
 * type is schema-sync-only: rows keep the orphaned values, and the
 * store sheds them on each row's next properties write (the
 * merged-update strip in `PostgresCaseStore.update`).
 *
 * Case-type additions produce one schema-sync-only entry so the
 * `case_type_schemas` row materializes the moment the blueprint
 * commits — without it, the first insert against the new case
 * type would fail the schema lookup with `SchemaNotSyncedError`.
 *
 * Rename detection: a rename and an "add new + remove old" pair are
 * indistinguishable at the property-LIST level, but fields carry
 * uuid identity — so the classifier proves a rename by pairing each
 * property that LEFT a case type's materializable view with a field
 * that wrote it in `prior` and, under the SAME uuid, writes a
 * property the prospective view holds. That evidence covers every
 * batch encoding of a rename: the `renameField` gesture (builder,
 * SA/MCP `edit_field`) and the diff-shaped batches undo/redo and
 * the collab reconciler emit (`updateField` id patch + catalog
 * add/remove pairs — `diffDocsToMutations` never emits
 * `renameField`). A same-batch rename CHAIN (A→B→C) collapses for
 * free: only the endpoints appear in the snapshots. A property
 * removal with no surviving writer under the same uuid stays a
 * remove — no rename entry, no per-row migration.
 *
 * `narrow-options` has no equivalent evidence (shrinking an option
 * set looks identical to removing the property, and options carry
 * no identity), so no narrow-options entry is ever synthesized;
 * that per-row migration arm is reachable only from the drift
 * scripts, which call `applySchemaChange` directly.
 */

import type { SchemaChangeKind } from "@/lib/case-store";
import {
	type BlueprintDoc,
	type CaseProperty,
	type CaseType,
	fieldCasePropertyOn,
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
 *   1. Synthesize rename entries (`synthesizeRenameEntries`) from
 *      the two snapshots: a property that left a case type's view
 *      paired with a same-uuid field that still writes the type
 *      under a new name proves a rename, and its entry carries the
 *      `rename` change so the case-store migrates row values
 *      old-key → new-key in the same transaction as the schema
 *      regen.
 *   2. Walk the prospective case types. For each case type
 *      present in both snapshots, diff the property lists. Any
 *      structural change (property added/removed, `data_type`
 *      shifted) yields one schema-sync-only entry per affected
 *      case type. A synthesized rename already covers the per-row
 *      work for its case type; the schema-sync entry is skipped
 *      to avoid issuing a redundant `applySchemaChange` for the
 *      same case type.
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

	const entries: CaseTypeChangeEntry[] = synthesizeRenameEntries(
		args,
		priorByName,
		prospectiveByName,
	);

	// Track which case types a rename entry already covers so the
	// per-property diff loop doesn't enqueue a redundant schema-sync
	// entry for the same case type. The rename's `applySchemaChange`
	// call already runs the schema regen alongside the per-row
	// migration.
	const caseTypesCoveredByRename = new Set(
		entries.map((entry) => entry.caseType),
	);

	for (const [name, prospectiveType] of prospectiveByName) {
		if (caseTypesCoveredByRename.has(name)) continue;

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
 * Prove renames from the two snapshots and emit one `rename`-change
 * entry per proven pair.
 *
 * A property P that left a case type's materializable view is a
 * rename — not a removal — exactly when some field that wrote
 * `(caseType, P)` in `prior` still exists under the SAME uuid in
 * `prospective`, still writes the same case type, and its id moved
 * to a name Q the prospective view declares. Field ids ARE the
 * property names for case-bound writers, and the uuid is the
 * identity the property-list diff lacks. The evidence works for
 * every batch encoding (gesture `renameField`, diff-shaped
 * undo/reconciler batches) and covers bare-writer DERIVED
 * properties — those never touch the catalog, so a cascade-meta or
 * catalog-diff approach would miss them.
 *
 * A merge-rename (Q was already declared before the rename) proves
 * the same way — Q is in the prospective view regardless of when it
 * was declared; the store's rename migration owns the value-level
 * merge semantics.
 *
 * Candidate uuids iterate in sorted order so a pathological
 * snapshot pair where peer writers of P diverge onto different new
 * names still resolves deterministically (first sorted uuid wins).
 */
function synthesizeRenameEntries(
	args: ClassifyArgs,
	priorByName: ReadonlyMap<string, CaseType>,
	prospectiveByName: ReadonlyMap<string, CaseType>,
): CaseTypeChangeEntry[] {
	const entries: CaseTypeChangeEntry[] = [];
	for (const [name, priorType] of priorByName) {
		const prospectiveType = prospectiveByName.get(name);
		if (prospectiveType === undefined) continue;
		const prospectiveProps = new Set(
			prospectiveType.properties.map((p) => p.name),
		);
		for (const prop of priorType.properties) {
			if (prospectiveProps.has(prop.name)) continue;
			const to = renamedTo(args, name, prop.name, prospectiveProps);
			if (to === undefined) continue;
			entries.push({
				caseType: name,
				property: to,
				change: { kind: "rename", from: prop.name, to },
			});
		}
	}
	return entries;
}

/**
 * Resolve the destination name a departed property was renamed to,
 * or `undefined` when no same-uuid writer evidence exists (a true
 * removal). See `synthesizeRenameEntries` for the evidence rule.
 */
function renamedTo(
	args: ClassifyArgs,
	caseType: string,
	from: string,
	prospectiveProps: ReadonlySet<string>,
): string | undefined {
	for (const uuid of Object.keys(args.prior.fields).sort()) {
		const priorField =
			args.prior.fields[uuid as keyof typeof args.prior.fields];
		if (priorField === undefined || priorField.id !== from) continue;
		if (fieldCasePropertyOn(priorField) !== caseType) continue;
		const prospectiveField =
			args.prospective.fields[uuid as keyof typeof args.prospective.fields];
		if (prospectiveField === undefined) continue;
		if (fieldCasePropertyOn(prospectiveField) !== caseType) continue;
		const to = prospectiveField.id;
		if (to === from || !prospectiveProps.has(to)) continue;
		return to;
	}
	return undefined;
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
