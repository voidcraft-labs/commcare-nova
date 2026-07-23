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
import { orderedCaseOperations } from "./forms";
import {
	ANY_TYPE,
	type CheckError,
	checkExpression,
	SEQUENCE_TYPE,
} from "./predicate/typeChecker";
import {
	isStandardCaseListProperty,
	STANDARD_CASE_LIST_PROPERTY_DATA_TYPES,
	standardCasePropertyDisplayLabel,
} from "./standardCaseProperties";
import type { Uuid } from "./uuid";
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

type PropertyWriter =
	| { readonly kind: "field"; readonly field: Field }
	| {
			readonly kind: "operation";
			readonly dataType: CasePropertyDataType | undefined;
	  };

/** Writer index for one doc: caseType → property → every writing surface. */
type WriterIndex = ReadonlyMap<
	string,
	ReadonlyMap<string, readonly PropertyWriter[]>
>;

const EFFECTIVE_CASE_TYPES_CACHE = new WeakMap<
	PersistableDoc,
	readonly CaseType[]
>();
const MATERIALIZABLE_CASE_TYPES_CACHE = new WeakMap<
	PersistableDoc,
	readonly CaseType[]
>();
const WRITER_INDEX_CACHE = new WeakMap<PersistableDoc, WriterIndex>();
const CONCRETE_WRITER_TYPES_CACHE = new WeakMap<
	PersistableDoc,
	ReadonlyMap<string, ReadonlyMap<string, ReadonlySet<CasePropertyDataType>>>
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
	const writers = writerIndex(doc);
	return materializeEffectiveCaseTypes(doc, writers);
}

function materializeEffectiveCaseTypes(
	doc: PersistableDoc,
	writers: WriterIndex,
): readonly CaseType[] {
	const writerType = writerTypeResolver(doc, writers);

	const declaredByType = new Map<string, ReadonlySet<string>>();
	for (const ct of doc.caseTypes ?? []) {
		declaredByType.set(ct.name, new Set(ct.properties.map((p) => p.name)));
	}

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
				label: standardCasePropertyDisplayLabel(name),
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

/** Consensus resolver shared by catalog materialization and disagreement
 * diagnostics. Hidden copy-writers recurse through this same index so a
 * field-derived type remains visible when an operation copies it. */
function writerTypeResolver(
	doc: PersistableDoc,
	writers: WriterIndex,
): (caseType: string, property: string) => CasePropertyDataType | undefined {
	// Memo + in-progress guard shared across the whole build so the
	// copy-chain recursion (hidden field reading another property)
	// resolves each (caseType, property) pair at most once and a
	// reference cycle resolves unknown instead of recursing forever.
	const memo = new Map<string, CasePropertyDataType | undefined>();
	const resolving = new Set<string>();

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
			const propertyWriters = writers.get(caseType)?.get(property) ?? [];
			const types = new Set<CasePropertyDataType>();
			for (const writer of propertyWriters) {
				const t =
					writer.kind === "operation"
						? writer.dataType
						: writer.field.kind === "hidden"
							? inferHiddenWriterType(writer.field, doc, writerType)
							: caseDataTypeForFieldKind(writer.field.kind);
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

	return writerType;
}

/**
 * Every concrete type opinion supplied by a field or case-operation writer,
 * grouped by `(caseType, property)`. Hidden fields and expressions whose type
 * cannot be resolved contribute no opinion. Validators use the set size to
 * reject conflicting operation writers before an ambiguous effective type can
 * reach schema materialization.
 */
export function concreteCasePropertyWriterTypes(
	doc: PersistableDoc,
): ReadonlyMap<string, ReadonlyMap<string, ReadonlySet<CasePropertyDataType>>> {
	const cached = CONCRETE_WRITER_TYPES_CACHE.get(doc);
	if (cached !== undefined) return cached;
	const result = new Map<string, Map<string, Set<CasePropertyDataType>>>();
	const writersByType = writerIndex(doc);
	const propertyType = writerTypeResolver(doc, writersByType);
	for (const [caseType, byProperty] of writersByType) {
		const resultByProperty = new Map<string, Set<CasePropertyDataType>>();
		result.set(caseType, resultByProperty);
		for (const [property, writers] of byProperty) {
			const types = new Set<CasePropertyDataType>();
			for (const writer of writers) {
				const dataType =
					writer.kind === "operation"
						? writer.dataType
						: writer.field.kind === "hidden"
							? inferHiddenWriterType(writer.field, doc, propertyType)
							: caseDataTypeForFieldKind(writer.field.kind);
				if (dataType !== undefined) types.add(dataType);
			}
			resultByProperty.set(property, types);
		}
	}
	CONCRETE_WRITER_TYPES_CACHE.set(doc, result);
	return result;
}

function writerIndex(doc: PersistableDoc): WriterIndex {
	const cached = WRITER_INDEX_CACHE.get(doc);
	if (cached !== undefined) return cached;
	const built = buildWriterIndex(doc);
	WRITER_INDEX_CACHE.set(doc, built);
	return built;
}

function buildWriterIndex(doc: PersistableDoc): WriterIndex {
	const fieldWriters = buildFieldWriterIndex(doc);
	const operationWrites = collectOperationWrites(doc);
	let operationTypes = operationWrites.map(
		() => undefined as CasePropertyDataType | undefined,
	);
	const history: Array<readonly (CasePropertyDataType | undefined)[]> = [
		operationTypes,
	];
	const seen = new Map<string, number>([[typeSignature(operationTypes), 0]]);

	// Operation expressions may copy an untyped property whose type is itself
	// derived from another operation. Re-materialize until the finite writer
	// type vector reaches a fixed point; on a pathological oscillation retain
	// only opinions stable across the cycle and leave the rest honestly unknown.
	for (let pass = 0; pass <= operationWrites.length + 1; pass += 1) {
		const working = cloneWriterIndex(fieldWriters);
		addOperationWriters(working, operationWrites, operationTypes);
		const checkerCaseTypes = concreteInferenceCaseTypes(
			materializeEffectiveCaseTypes(doc, working),
		);
		const next = operationWrites.map((write) =>
			inferOperationWriteType(write, checkerCaseTypes),
		);
		if (sameTypes(next, operationTypes)) {
			operationTypes = next;
			break;
		}
		const signature = typeSignature(next);
		const cycleStart = seen.get(signature);
		if (cycleStart !== undefined) {
			const cycle = [...history.slice(cycleStart), next];
			operationTypes = next.map((_, index) => {
				const opinions = new Set(cycle.map((state) => state[index]));
				return opinions.size === 1 ? cycle[0][index] : undefined;
			});
			break;
		}
		operationTypes = next;
		seen.set(signature, history.length);
		history.push(next);
	}

	const index = cloneWriterIndex(fieldWriters);
	addOperationWriters(index, operationWrites, operationTypes);
	return index;
}

/**
 * Type derivation must distinguish an authored-but-untyped property from a
 * concrete text opinion. The ordinary expression checker intentionally treats
 * absent metadata as text at runtime; feeding that fallback into this fixed
 * point would make a mutual copy cycle manufacture a text schema from no
 * writer fact at all. Omit unresolved properties only for the inference pass,
 * so direct-copy chains converge once a real writer opinion arrives and cycles
 * remain honestly unknown.
 */
function concreteInferenceCaseTypes(
	caseTypes: readonly CaseType[],
): readonly CaseType[] {
	return caseTypes.map((caseType) => ({
		...caseType,
		properties: caseType.properties.filter(
			(property) => property.data_type !== undefined,
		),
	}));
}

type MutableWriterIndex = Map<string, Map<string, PropertyWriter[]>>;

interface OperationWriteToInfer {
	readonly caseType: string;
	readonly property: string;
	readonly value: import("./predicate/types").ValueExpression;
	readonly currentCaseType: string | undefined;
	readonly formFields: ReadonlyMap<Uuid, CasePropertyDataType | undefined>;
	readonly operationIds: ReadonlySet<Uuid>;
}

function buildFieldWriterIndex(doc: PersistableDoc): MutableWriterIndex {
	const index = new Map<string, Map<string, PropertyWriter[]>>();
	for (const field of Object.values(doc.fields)) {
		const caseType = fieldCasePropertyOn(field);
		if (caseType === undefined || field.id.length === 0) continue;
		addWriter(index, caseType, field.id, { kind: "field", field });
	}
	return index;
}

function collectOperationWrites(doc: PersistableDoc): OperationWriteToInfer[] {
	const result: OperationWriteToInfer[] = [];
	for (const [formUuid, form] of Object.entries(doc.forms)) {
		const formFields = collectFormFieldTypes(doc, formUuid);
		const currentCaseType = moduleCaseTypeForForm(doc, formUuid);
		const operationIds = new Set<Uuid>();
		for (const operation of orderedCaseOperations(form)) {
			const destinationType = operation.retype ?? operation.caseType;
			for (const write of operation.writes ?? []) {
				if (write.property.length > 0) {
					result.push({
						caseType: destinationType,
						property: write.property,
						value: write.value,
						currentCaseType,
						formFields,
						operationIds: new Set(operationIds),
					});
				}
			}
			if (operation.action === "create") operationIds.add(operation.uuid);
		}
	}
	return result;
}

function inferOperationWriteType(
	write: OperationWriteToInfer,
	caseTypes: readonly CaseType[],
): CasePropertyDataType | undefined {
	const errors: CheckError[] = [];
	const resolved = checkExpression(
		write.value,
		{
			caseTypes: [...caseTypes],
			knownInputs: [],
			// Values read the containing form's pre-submission case even when
			// their operation creates or retypes a different destination.
			currentCaseType: write.currentCaseType,
			formFields: write.formFields,
			operationIds: write.operationIds,
			caseOperationValues: true,
		},
		errors,
		[],
	);
	return errors.length === 0 &&
		resolved !== undefined &&
		resolved !== ANY_TYPE &&
		resolved !== SEQUENCE_TYPE
		? resolved
		: undefined;
}

function addOperationWriters(
	index: MutableWriterIndex,
	writes: readonly OperationWriteToInfer[],
	types: readonly (CasePropertyDataType | undefined)[],
): void {
	for (let position = 0; position < writes.length; position += 1) {
		const write = writes[position];
		addWriter(index, write.caseType, write.property, {
			kind: "operation",
			dataType: types[position],
		});
	}
}

function addWriter(
	index: MutableWriterIndex,
	caseType: string,
	property: string,
	writer: PropertyWriter,
): void {
	let byProperty = index.get(caseType);
	if (byProperty === undefined) {
		byProperty = new Map();
		index.set(caseType, byProperty);
	}
	const writers = byProperty.get(property);
	if (writers === undefined) byProperty.set(property, [writer]);
	else writers.push(writer);
}

function cloneWriterIndex(index: WriterIndex): MutableWriterIndex {
	return new Map(
		[...index].map(([caseType, byProperty]) => [
			caseType,
			new Map(
				[...byProperty].map(([property, writers]) => [property, [...writers]]),
			),
		]),
	);
}

function sameTypes(
	left: readonly (CasePropertyDataType | undefined)[],
	right: readonly (CasePropertyDataType | undefined)[],
): boolean {
	return (
		left.length === right.length &&
		left.every((type, index) => type === right[index])
	);
}

function typeSignature(
	types: readonly (CasePropertyDataType | undefined)[],
): string {
	return JSON.stringify(types.map((type) => type ?? null));
}

function moduleCaseTypeForForm(
	doc: PersistableDoc,
	formUuid: string,
): string | undefined {
	for (const [moduleUuid, formUuids] of Object.entries(doc.formOrder)) {
		if (formUuids.includes(formUuid as import("./uuid").Uuid)) {
			return doc.modules[moduleUuid]?.caseType;
		}
	}
	return undefined;
}

function collectFormFieldTypes(
	doc: PersistableDoc,
	formUuid: string,
): ReadonlyMap<Uuid, CasePropertyDataType | undefined> {
	const result = new Map<Uuid, CasePropertyDataType | undefined>();
	const stack = [...(doc.fieldOrder[formUuid] ?? [])];
	while (stack.length > 0) {
		const uuid = stack.pop();
		if (uuid === undefined) break;
		const field = doc.fields[uuid];
		if (field === undefined) continue;
		const dataType = caseDataTypeForFieldKind(field.kind);
		if (dataType !== undefined || field.kind === "hidden") {
			result.set(uuid, dataType);
		}
		stack.push(...(doc.fieldOrder[uuid] ?? []));
	}
	return result;
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
