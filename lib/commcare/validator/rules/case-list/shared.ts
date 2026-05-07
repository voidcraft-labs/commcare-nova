/**
 * Shared helpers for case-list-config validation rules.
 *
 * Two cross-cutting concerns live here:
 *
 *   1. **Property resolution** — every case-list-config rule that
 *      reads a property by name routes through the same admission
 *      set, so a property that exists for one rule exists for
 *      every rule and vice versa. Single source of truth at the
 *      `resolvePropertyDataType` / `propertyExists` /
 *      `augmentedCaseTypes` helpers below.
 *   2. **TypeContext composition** — predicate / value-expression
 *      checks (`filterTypeCheck`, `calculatedColumnTypeCheck`)
 *      consume a `TypeContext` whose `caseTypes` carry the
 *      augmented admission set so the predicate AST type checker
 *      sees writer-derived + standard properties as declared. The
 *      `moduleTypeContext` helper wires this up with the module's
 *      search-input declarations included.
 *
 * ## Property resolution model (rule-set-wide contract)
 *
 * A property is considered to "exist" on a case type if any of the
 * following holds, in this priority order:
 *
 *   1. Declared on `ct.properties[]` — the canonical schema. Data
 *      type comes from the property's `data_type` (with the
 *      `?? "text"` fallback via `effectiveDataType`).
 *
 *   2. CommCare standard property (member of
 *      `STANDARD_CASE_LIST_PROPERTIES`) — implicit-typed via
 *      `STANDARD_CASE_LIST_PROPERTY_DATA_TYPES`. CommCare provides
 *      these at the wire layer; the blueprint never lists them.
 *
 *   3. Writer-derived — some form field saves to the property via
 *      `case_property_on === ct.name`. Walked by
 *      `collectCaseProperties(doc, caseType)`. Data type defaults to
 *      `text` because the case type's schema declares none for this
 *      property; the wire layer accepts any string-coerceable value.
 *
 * Every case-list-config rule consults this same admission set:
 *
 *   - `columnReferences` — `propertyExists` (existence only; no type
 *     check).
 *   - `sortTypeCheck` — `resolvePropertyDataType` for type-driven
 *     `applicableSortTypes(...)` selection.
 *   - `searchInputModeMatchesPropertyType` — `resolvePropertyDataType`
 *     for `SEARCH_MODE_PROPERTY_TYPES` admission.
 *   - `filterTypeCheck` / `calculatedColumnTypeCheck` — delegate to
 *     `checkPredicate` / `checkValueExpression`, which resolve only
 *     against `ct.properties[]`. Routing through `moduleTypeContext`
 *     supplies an `augmentedCaseTypes`-widened list so writer-
 *     derived + standard properties resolve to their effective data
 *     types as if declared. This keeps the predicate-AST type
 *     checker semantically aligned with the case-store runtime
 *     (which accepts every property the case-store actually emits)
 *     without modifying the type checker itself.
 */

import {
	isStandardCaseListProperty,
	STANDARD_CASE_LIST_PROPERTIES,
	STANDARD_CASE_LIST_PROPERTY_DATA_TYPES,
} from "@/lib/commcare";
import type {
	BlueprintDoc,
	CaseProperty,
	CaseType,
	Module,
} from "@/lib/domain";
import {
	type CasePropertyDataType,
	effectiveDataType,
} from "@/lib/domain/casePropertyTypes";
import type {
	CheckPath,
	SearchInputDecl,
	TypeContext,
} from "@/lib/domain/predicate";
import { collectCaseProperties } from "../../index";

/**
 * Build the `TypeContext` a per-module type-checker call runs against.
 *
 * `caseTypes` is the augmented case-type list — see
 * `augmentedCaseTypes` — so the predicate AST type checker resolves
 * writer-derived + standard properties as if declared on
 * `ct.properties[]`. Rules that delegate to the type checker
 * (`filterTypeCheck`, `calculatedColumnTypeCheck`) thus consume the
 * same admission set as the per-rule property resolvers
 * (`sortTypeCheck`, `searchInputModeMatchesPropertyType`,
 * `columnReferences`).
 *
 * `knownInputs` is derived from the module's own
 * `caseListConfig.searchInputs`. Each declaration carries the input's
 * declared `name` plus the resolved `data_type` (when the input
 * targets a known property on the module's case type) so the type
 * checker can compare `input(...)` operands against the right side of
 * comparisons. Inputs without a resolvable property fall back to
 * `text` (the type checker's default for un-annotated declarations).
 *
 * `currentCaseType` is set to the module's case type so the
 * relational quantifiers (`exists` / `missing`) and the destination-
 * scope pin inside their `where` clauses can resolve property
 * references against the surrounding `via`'s destination scope.
 */
export function moduleTypeContext(mod: Module, doc: BlueprintDoc): TypeContext {
	const inputs = mod.caseListConfig?.searchInputs ?? [];
	const moduleCaseType = mod.caseType;
	const augmented = augmentedCaseTypes(doc);

	const knownInputs: SearchInputDecl[] = [];
	for (const input of inputs) {
		// Without a `property`, the input is "advanced" (its predicate is
		// expressed via the `xpath` slot); the type checker has no
		// declared `data_type` to bind. Default to `text` — the same
		// fallback the type checker applies for un-annotated declarations.
		if (!input.property || !moduleCaseType) {
			knownInputs.push({ name: input.name });
			continue;
		}
		// Self-walk (`via` absent or `kind === "self"`) resolves on the
		// module's own case type. Cross-walk inputs (`via` carrying an
		// `ancestor` / `subcase` / `any-relation` step) resolve against
		// their destination case type — the surrounding type-check call
		// validates the walk separately, so the input's declaration here
		// trusts the user's intent and falls back to `text` when the walk
		// is non-trivial. The declaration's `data_type` is a hint, not a
		// gate; widening to text on cross-walks just defers to the wire
		// layer's text-coerced equality.
		const isSelfWalk = !input.via || input.via.kind === "self";
		if (!isSelfWalk) {
			knownInputs.push({ name: input.name });
			continue;
		}
		// Resolve against the augmented list so writer-derived /
		// standard properties contribute their effective data type to
		// the input's declaration.
		const dataType = resolvePropertyDataTypeFromAugmented(
			augmented,
			moduleCaseType,
			input.property,
		);
		const decl: SearchInputDecl = dataType
			? { name: input.name, data_type: dataType }
			: { name: input.name };
		knownInputs.push(decl);
	}

	return {
		caseTypes: augmented,
		knownInputs,
		...(moduleCaseType !== undefined && { currentCaseType: moduleCaseType }),
	};
}

/**
 * Format a `CheckPath` for inclusion in an error message — joins the
 * segments with `.` so the editor / SA can locate the offending node
 * inside the AST. An empty path renders as the empty string so the
 * surrounding sentence reads cleanly when the error attaches to the
 * predicate's own root.
 */
export function formatPath(path: CheckPath): string {
	if (path.length === 0) return "";
	return path
		.map((seg) => (typeof seg === "number" ? `[${seg}]` : seg))
		.join(".");
}

// ── Property resolution helpers ──────────────────────────────────

/**
 * Resolve a property's effective `data_type` against the rule-set-
 * wide three-arm admission set. Returns `undefined` when the
 * property exists nowhere; callers report the missing-property as a
 * structural error.
 *
 * Priority order matches the contract in the file header:
 * declared → standard → writer-derived. Conflicts resolve in favor
 * of the higher-priority arm.
 *
 * `writerProps` is an optional precomputed set of writer-derived
 * property names for the target case type. Callers that resolve
 * many properties against the same case type should hoist the
 * collection once and pass it in to avoid per-call walking of the
 * full doc; callers resolving a single property can omit the
 * argument and the helper computes the set lazily.
 */
export function resolvePropertyDataType(
	doc: BlueprintDoc,
	caseType: string,
	propertyName: string,
	writerProps?: ReadonlySet<string>,
): CasePropertyDataType | undefined {
	// Priority 1: declared on `ct.properties[]`.
	const ct = doc.caseTypes?.find((c) => c.name === caseType);
	const declared = ct?.properties.find((p) => p.name === propertyName);
	if (declared) return effectiveDataType(declared);

	// Priority 2: CommCare standard property — implicit-typed.
	if (isStandardCaseListProperty(propertyName)) {
		return STANDARD_CASE_LIST_PROPERTY_DATA_TYPES[propertyName];
	}

	// Priority 3: writer-derived — text default.
	const writers =
		writerProps ?? collectCaseProperties(doc, caseType) ?? new Set<string>();
	if (writers.has(propertyName)) return "text";

	return undefined;
}

/**
 * `true` when the property exists in the rule-set-wide admission
 * set (declared, standard, or writer-derived). Thin existence
 * predicate for rules that don't need the resolved data type
 * (`columnReferences`).
 */
export function propertyExists(
	doc: BlueprintDoc,
	caseType: string,
	propertyName: string,
	writerProps?: ReadonlySet<string>,
): boolean {
	return (
		resolvePropertyDataType(doc, caseType, propertyName, writerProps) !==
		undefined
	);
}

/**
 * Project the doc's `caseTypes` list with each case type's
 * `properties[]` extended to include the rule-set-wide admission
 * set: writer-derived (typed `text`) + CommCare standard (typed via
 * `STANDARD_CASE_LIST_PROPERTY_DATA_TYPES`). Declared properties
 * win on conflict.
 *
 * Routed through by `moduleTypeContext` so the predicate AST type
 * checker (which resolves only against `ct.properties[]`) sees the
 * same admission set the per-rule resolvers use. Without this
 * augmentation, `filterTypeCheck` / `calculatedColumnTypeCheck`
 * would silently fire "Unknown property" on writer-derived /
 * standard properties that the runtime accepts.
 */
export function augmentedCaseTypes(doc: BlueprintDoc): CaseType[] {
	const caseTypes = doc.caseTypes ?? [];
	return caseTypes.map((ct) => augmentCaseType(ct, doc));
}

function augmentCaseType(ct: CaseType, doc: BlueprintDoc): CaseType {
	const declaredNames = new Set(ct.properties.map((p) => p.name));
	const extra: CaseProperty[] = [];

	// Standard properties — only inject when not declared. CommCare
	// admits them implicitly; the blueprint may also declare them
	// (the schema doesn't forbid it), in which case the declared
	// arm wins and we don't shadow it.
	for (const name of STANDARD_CASE_LIST_PROPERTIES) {
		if (declaredNames.has(name)) continue;
		const dataType = isStandardCaseListProperty(name)
			? STANDARD_CASE_LIST_PROPERTY_DATA_TYPES[name]
			: undefined;
		if (dataType === undefined) continue;
		extra.push({ name, label: name, data_type: dataType });
	}

	// Writer-derived properties — fields saving to this case type
	// via `case_property_on`. Default to text per the model's
	// undeclared-fallback convention. Skip names already declared OR
	// already injected as standard above.
	const writerProps = collectCaseProperties(doc, ct.name) ?? new Set<string>();
	const injected = new Set(extra.map((p) => p.name));
	for (const name of writerProps) {
		if (declaredNames.has(name)) continue;
		if (injected.has(name)) continue;
		extra.push({ name, label: name, data_type: "text" });
	}

	if (extra.length === 0) return ct;
	return { ...ct, properties: [...ct.properties, ...extra] };
}

/**
 * Resolve a property's data type against an already-augmented case-
 * type list. Used internally by `moduleTypeContext` to populate
 * search-input data types without walking the doc twice.
 */
function resolvePropertyDataTypeFromAugmented(
	augmented: readonly CaseType[],
	caseType: string,
	propertyName: string,
): CasePropertyDataType | undefined {
	const ct = augmented.find((c) => c.name === caseType);
	const property = ct?.properties.find((p) => p.name === propertyName);
	return property ? effectiveDataType(property) : undefined;
}
