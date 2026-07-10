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
// the validator's writer-agreement rules
// (`FIELD_KIND_PROPERTY_TYPE_MISMATCH`, `FIELD_KIND_WRITERS_DISAGREE`)
// force declaration and writers to agree in any valid doc — which is
// exactly what makes "declared ?? writer-derived" well-defined.
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
// **Unknown is honest.** A property whose type nothing pins —
// hidden-only writers whose expressions defeat inference, or writer
// disagreement on a legacy doc — keeps `data_type` ABSENT. It is
// never stamped `"text"`: value-semantics consumers (the predicate
// type checker, the SQL compiler, JSON-schema generation) still
// read absent as text via the `effectiveDataType` convention, but
// COMPATIBILITY verdicts (column-kind applicability, pickers) treat
// absent as "no opinion" — missing metadata is not a fact.
//
// This is a derived view, memoized per doc reference like
// `fieldParent` / `refIndex` — never persisted, no migration.
//
// ## Hidden-writer inference
//
// A `hidden` field pins no kind-derived type — its written value's
// type is its expression's. The inference here is deliberately
// STRUCTURAL, not a parser: the stored XPath AST keeps reference
// leaves typed (`case-ref` / `field-ref` / `path-ref`) and
// everything else as verbatim text runs, so without parsing we can
// resolve exactly three shapes:
//
//   - a lone `case-ref` part — the value IS a copy of another
//     property; recurse into its effective type (cycle-guarded).
//   - a lone text run that EXACTLY equals a known zero-argument
//     call (`today()` / `now()`, modulo surrounding whitespace).
//     This is string equality against a closed table — not
//     structure extraction; any other spelling simply misses and
//     resolves unknown, which is permissive everywhere.
//
// Everything else — arithmetic, concat, conditionals, form-field
// references — resolves unknown. Form-field refs are EXCLUDED on
// purpose, not for difficulty: keeping the derived state a function
// of catalog + bound-writer state only is what lets the incremental
// validator's scoping (`scopeOfMutations.ts`) stay sound — its
// existing full-run triggers cover exactly those inputs, while an
// unbound reference target's edits would leak past any entity-keyed
// scope. Deeper inference belongs to a real expression type checker
// over the parsed grammar (a `lib/commcare` concern), and
// unknown-is-permissive means its absence never blocks an author.

import type { CaseProperty, CaseType, PersistableDoc } from "./blueprint";
import type { CasePropertyDataType } from "./casePropertyTypes";
import { caseDataTypeForFieldKind, fieldCasePropertyOn } from "./caseTypes";
import type { Field, HiddenField } from "./fields";
import {
	isStandardCaseListProperty,
	STANDARD_CASE_LIST_PROPERTY_DATA_TYPES,
} from "./standardCaseProperties";
import type { XPathExpression } from "./xpath";

/**
 * Whole-expression text runs that resolve to a known type. String
 * EQUALITY against the trimmed run — never tokenization or pattern
 * matching (XPath structure is read via the Lezer grammar, which
 * lives behind `lib/commcare`; this table deliberately stops where
 * equality stops). A miss resolves unknown, which is permissive.
 */
const WHOLE_EXPRESSION_TYPES: ReadonlyMap<string, CasePropertyDataType> =
	new Map([
		["today()", "date"],
		["now()", "datetime"],
	]);

/** Writer index for one doc: caseType → property → writing fields. */
type WriterIndex = ReadonlyMap<string, ReadonlyMap<string, readonly Field[]>>;

const EFFECTIVE_CASE_TYPES_CACHE = new WeakMap<
	PersistableDoc,
	readonly CaseType[]
>();
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
 * type is a validator finding (`CASE_PROPERTY_ON_UNKNOWN_TYPE`), not
 * a type this view invents.
 */
export function effectiveCaseTypes(doc: PersistableDoc): readonly CaseType[] {
	const cached = EFFECTIVE_CASE_TYPES_CACHE.get(doc);
	if (cached !== undefined) return cached;
	const built = buildEffectiveCaseTypes(doc);
	EFFECTIVE_CASE_TYPES_CACHE.set(doc, built);
	return built;
}

/**
 * The effective view MINUS the standard-only entries — what the
 * case-store's schema materialization (`case_type_schemas` rows,
 * JSON-schema insert validation, per-property expression indexes)
 * derives from. The standard properties are CommCare runtime
 * metadata, not stored JSONB values: materializing them would put
 * `format` constraints on keys inserts never carry and mint a
 * per-case-type expression INDEX for every text-typed standard name
 * (real write-amplification for keys that are never populated). A
 * DECLARED standard-named property (`case_name`) still materializes
 * — only the implicit injections drop. (A written-but-undeclared
 * standard name doesn't materialize in either flavor's writer arm:
 * `case_name` routes to the `cases.case_name` COLUMN, not the JSONB
 * document, so a schema entry for it would constrain a key inserts
 * never carry.)
 *
 * The SQL compiler's schema map consumes this flavor too: standard
 * values are not stored in the JSONB document, so resolving one
 * would compile a silently-NULL read — the loud `lookupDataType`
 * failure is the honest behavior until standard names map onto
 * their scalar columns. Only the type CHECKER's admission set
 * (`effectiveCaseTypes`) carries the standard entries.
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

function buildEffectiveCaseTypes(doc: PersistableDoc): readonly CaseType[] {
	const writers = buildWriterIndex(doc);
	// Memo + in-progress guard shared across the whole build so the
	// copy-chain recursion (hidden field reading another property)
	// resolves each (caseType, property) pair at most once and a
	// reference cycle resolves unknown instead of recursing forever.
	const memo = new Map<string, CasePropertyDataType | undefined>();
	const resolving = new Set<string>();

	const declaredByType = new Map<string, ReadonlySet<string>>();
	for (const ct of doc.caseTypes ?? []) {
		declaredByType.set(ct.name, new Set(ct.properties.map((p) => p.name)));
	}

	/** Writer-derived type for `(caseType, property)` — the agreed
	 *  type across every writer that resolves one, else unknown. */
	const writerType = (
		caseType: string,
		property: string,
	): CasePropertyDataType | undefined => {
		const key = `${caseType}\u0000${property}`;
		if (memo.has(key)) return memo.get(key);
		if (resolving.has(key)) return undefined; // reference cycle
		resolving.add(key);
		try {
			const fields = writers.get(caseType)?.get(property) ?? [];
			const types = new Set<CasePropertyDataType>();
			for (const field of fields) {
				const t =
					field.kind === "hidden"
						? inferHiddenWriterType(field, doc, writerType)
						: caseDataTypeForFieldKind(field.kind);
				if (t !== undefined) types.add(t);
			}
			// Exactly one resolved opinion is a fact; zero is unknown;
			// disagreement (a legacy doc the writer-agreement rules
			// haven't repaired) is unknown rather than a coin flip.
			const resolved = types.size === 1 ? [...types][0] : undefined;
			// Memoize only at the OUTERMOST frame. A nested resolution can
			// have been truncated by the cycle guard above (an in-flight
			// ancestor read as unknown), so caching it would freeze an
			// order-dependent answer; the outermost frame saw no ancestor
			// and its result is the true fixpoint.
			if (resolving.size === 1) memo.set(key, resolved);
			return resolved;
		} finally {
			resolving.delete(key);
		}
	};

	const result: CaseType[] = [];
	for (const ct of doc.caseTypes ?? []) {
		const declaredNames = declaredByType.get(ct.name) ?? new Set<string>();
		const properties: CaseProperty[] = ct.properties.map((p) => {
			if (p.data_type !== undefined) return p;
			const derived = writerType(ct.name, p.name);
			return derived === undefined ? p : { ...p, data_type: derived };
		});

		for (const name of Object.keys(STANDARD_CASE_LIST_PROPERTY_DATA_TYPES)) {
			if (declaredNames.has(name)) continue;
			if (!isStandardCaseListProperty(name)) continue;
			properties.push({
				name,
				label: name,
				data_type: STANDARD_CASE_LIST_PROPERTY_DATA_TYPES[name],
			});
		}

		const written = writers.get(ct.name);
		if (written !== undefined) {
			for (const name of written.keys()) {
				if (declaredNames.has(name)) continue;
				if (isStandardCaseListProperty(name)) continue;
				const derived = writerType(ct.name, name);
				properties.push({
					name,
					label: name,
					...(derived !== undefined && { data_type: derived }),
				});
			}
		}

		result.push({ ...ct, properties });
	}
	return result;
}

function buildWriterIndex(doc: PersistableDoc): WriterIndex {
	const index = new Map<string, Map<string, Field[]>>();
	for (const field of Object.values(doc.fields)) {
		const caseType = fieldCasePropertyOn(field);
		if (caseType === undefined || field.id.length === 0) continue;
		let byProperty = index.get(caseType);
		if (byProperty === undefined) {
			byProperty = new Map();
			index.set(caseType, byProperty);
		}
		const writersOfProperty = byProperty.get(field.id);
		if (writersOfProperty === undefined) byProperty.set(field.id, [field]);
		else writersOfProperty.push(field);
	}
	return index;
}

/**
 * Structural type inference for a hidden writer — see the module
 * header for the exact (deliberately closed) shape vocabulary. The
 * `calculate` slot wins over `default_value` when both are present,
 * mirroring the wire semantic (a bind calculate re-evaluates over
 * the setvalue seed).
 */
function inferHiddenWriterType(
	field: HiddenField,
	doc: PersistableDoc,
	writerType: (
		caseType: string,
		property: string,
	) => CasePropertyDataType | undefined,
): CasePropertyDataType | undefined {
	const source = field.calculate ?? field.default_value;
	if (source === undefined) return undefined;
	return inferExpressionType(source, doc, writerType);
}

function inferExpressionType(
	expr: XPathExpression,
	doc: PersistableDoc,
	writerType: (
		caseType: string,
		property: string,
	) => CasePropertyDataType | undefined,
): CasePropertyDataType | undefined {
	// Whitespace-only text runs around a single reference leaf are
	// still "a lone reference"; any other second part defeats the
	// structural read.
	const parts = expr.parts.filter(
		(part) => !(part.kind === "text" && part.text.trim().length === 0),
	);
	if (parts.length !== 1) return undefined;
	const part = parts[0];
	switch (part.kind) {
		case "text":
			return WHOLE_EXPRESSION_TYPES.get(part.text.trim());
		case "case-ref": {
			// A copy of another property — its effective type, in the same
			// precedence the catalog build applies: declared annotation,
			// else the standard set (a copy of `date_opened` IS a
			// datetime), else the writer derivation, which the shared
			// `resolving` set cycle-guards.
			const declared = (doc.caseTypes ?? [])
				.find((ct) => ct.name === part.caseType)
				?.properties.find((p) => p.name === part.property)?.data_type;
			if (declared !== undefined) return declared;
			if (isStandardCaseListProperty(part.property)) {
				return STANDARD_CASE_LIST_PROPERTY_DATA_TYPES[part.property];
			}
			return writerType(part.caseType, part.property);
		}
		case "field-ref":
		case "path-ref":
		case "user-ref":
		case "raw-ref":
			// Form-field / user / unresolvable refs stay unknown — see the
			// module header for why field refs are excluded on purpose.
			return undefined;
	}
}
