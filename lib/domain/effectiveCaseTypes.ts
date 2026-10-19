// lib/domain/effectiveCaseTypes.ts
//
// The EFFECTIVE case-type view — property types as derived facts.
//
// The persisted catalog (`doc.caseTypes`) is a generation-time seed:
// a property's `data_type` is whatever the SA's plan declared, and
// most properties declare none. But the blueprint already CONTAINS
// the authoritative typing information — the writers. A `date` field
// saving to `date_of_birth` pins that property's type by
// construction (`caseDataTypeForFieldKind` is the locked table), and
// the validator's writer-agreement rules (`FIELD_KIND_PROPERTY_TYPE_MISMATCH`,
// `FIELD_KIND_WRITERS_DISAGREE`, `CASE_OPERATION_EXPRESSION_TYPE`,
// `HIDDEN_VALUE_WRITER_TYPE_MISMATCH`) force declaration and writers to
// agree in any valid doc — which is exactly what makes
// "declared ?? writer-derived" well-defined.
//
// `effectiveCaseTypes(doc)` is that resolution, materialized as a
// catalog every consumer already speaks (`CaseType[]`):
//
//   1. Declared entries keep their annotation; an UNTYPED declared
//      entry gets its `data_type` filled from the writers when they
//      resolve one.
//   2. The CommCare standard properties (`case_name`, `date_opened`,
//      …) are appended with their implicit wire types.
//   3. Writer-derived properties (a field saves to the type but no
//      declaration exists) are appended, typed by their writers when
//      resolvable.
//
// The writers' types are one fixpoint, `expression/inference.ts`: a
// visible question's kind, each case operation's value, and each Hidden
// Value's value typed in its own slot. A property's type is its
// declaration, else the one opinion of its visible and operation writers,
// else the one agreed opinion of its Hidden Value writers. This module is
// its catalog projection.
//
// **Unknown is honest.** A property whose type nothing pins —
// writers whose values no fact types (a cycle of copies, a read of an
// untyped property), or writer disagreement on an invalid candidate —
// keeps `data_type` ABSENT. It is
// never stamped `"text"`: value-semantics consumers (the predicate
// type checker, the SQL compiler, JSON-schema generation) still
// read absent as text via the `effectiveDataType` convention, but
// COMPATIBILITY verdicts (column-kind applicability, pickers) treat
// absent as "no opinion" — missing metadata is not a fact.
//
// This is a derived view, memoized per doc reference like
// `fieldParent` / `refIndex` — never persisted, no migration.

import type { CaseType, PersistableDoc } from "./blueprint";
import type { CasePropertyDataType } from "./casePropertyTypes";
import { inferExpressionTypes } from "./expression/inference";
import { isStandardCaseListProperty } from "./standardCaseProperties";

const MATERIALIZABLE_CASE_TYPES_CACHE = new WeakMap<
	PersistableDoc,
	readonly CaseType[]
>();

/**
 * The effective case-type catalog for a doc — declared entries with
 * writer-derived `data_type` filled where the declaration is silent,
 * plus the standard properties, plus writer-derived entries for
 * properties no declaration lists. See the module header for the
 * full model. Memoized per doc reference (the doc store replaces the
 * reference on every mutation, so staleness is unreachable).
 *
 * Only DECLARED case types appear — a field writing to an undeclared
 * type is a validator finding (`CASE_WRITE_UNKNOWN_TYPE`), not
 * a type this view invents.
 */
export function effectiveCaseTypes(doc: PersistableDoc): readonly CaseType[] {
	return inferExpressionTypes(doc).caseTypes;
}

/**
 * The effective view minus standard-only injected entries. A DECLARED
 * standard-named entry remains because the catalog owns authoring metadata and
 * order. Storage projections are narrower still: `caseTypeToJsonSchema` and
 * `computeDesiredIndexSet` independently exclude every scalar-backed name, so
 * no declared standard entry becomes a JSONB key or expression index.
 *
 * The SQL compiler consumes this flavor too. Standard-name reads resolve
 * through `RESERVED_SCALAR_COLUMN_BY_PROPERTY` before catalog lookup, so an
 * explicit standard entry retains its authoring projection while runtime SQL
 * still reads the first-class case column.
 */
export function materializableCaseTypes(
	doc: PersistableDoc,
): readonly CaseType[] {
	const cached = MATERIALIZABLE_CASE_TYPES_CACHE.get(doc);
	if (cached !== undefined) return cached;
	// A projection over the one memoized build — an entry is
	// standard-INJECTED (dropped here) iff its name is standard and no
	// declaration carries it; everything else, including a declared
	// standard-named property, passes through by reference.
	const declaredByType = new Map(
		(doc.caseTypes ?? []).map((ct) => [
			ct.name,
			new Set(ct.properties.map((p) => p.name)),
		]),
	);
	const built = effectiveCaseTypes(doc).map((ct) => {
		const declared = declaredByType.get(ct.name);
		const properties = ct.properties.filter(
			(p) => !isStandardCaseListProperty(p.name) || declared?.has(p.name),
		);
		return properties.length === ct.properties.length
			? ct
			: { ...ct, properties };
	});
	MATERIALIZABLE_CASE_TYPES_CACHE.set(doc, built);
	return built;
}

/**
 * Every concrete type opinion supplied by a writer, grouped by
 * `(caseType, property)`: a visible question's kind, a case operation's
 * value, and a Hidden Value's agreed output type. A writer whose value no
 * fact types, and a Hidden Value's preloaded starting value, contribute no
 * opinion. Validators use the set size to reject conflicting operation
 * writers before an ambiguous effective type can reach schema
 * materialization.
 */
export function concreteCasePropertyWriterTypes(
	doc: PersistableDoc,
): ReadonlyMap<string, ReadonlyMap<string, ReadonlySet<CasePropertyDataType>>> {
	return inferExpressionTypes(doc).writerOpinions;
}
