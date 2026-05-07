/**
 * Shared helpers for case-list-config validation rules.
 *
 * Each per-module rule (`filterTypeCheck`, `sortTypeCheck`,
 * `calculatedColumnTypeCheck`, etc.) needs the same `TypeContext`
 * pinned to the module's case type, with the module's
 * `caseListConfig.searchInputs` declared as in-scope inputs so any
 * `input(...)` term inside a filter / calculated-column expression
 * resolves rather than firing an "unknown search input" error. Each
 * rule also formats `CheckPath` segments into a readable per-error
 * suffix; centralizing both pieces keeps the rules thin and rules out
 * drift between callers.
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
 * The case-list-config rules
 * (`columnReferences`, `filterTypeCheck`, `sortTypeCheck`,
 * `calculatedColumnTypeCheck`, `searchInputModeMatchesPropertyType`)
 * all consult this same admission set. The predicate-AST type
 * checker (`checkPredicate`, `checkValueExpression`) is stricter — it
 * resolves only against `ct.properties[]` because its types come from
 * the AST schema's `prop` term, which carries no implicit-typing
 * fallback. Type-checker errors against writer-derived properties
 * surface as "Unknown property"; the per-rule resolution above
 * widens the admission to keep authoring surfaces (sort, search
 * input, column reference) in sync with what the case-store actually
 * emits at runtime.
 */

import type { CaseType, Module } from "@/lib/domain";
import type {
	CheckPath,
	SearchInputDecl,
	TypeContext,
} from "@/lib/domain/predicate";

/**
 * Build the `TypeContext` a per-module type-checker call runs against.
 *
 * `caseTypes` widens to `[]` when the doc declares no case types
 * (`doc.caseTypes` is `CaseType[] | null` per the persisted shape) so
 * downstream resolution surfaces friendly "unknown case type" errors
 * rather than NPE on a missing slot.
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
export function moduleTypeContext(
	mod: Module,
	caseTypes: readonly CaseType[],
): TypeContext {
	const inputs = mod.caseListConfig?.searchInputs ?? [];
	const moduleCaseType = mod.caseType;

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
		const ct = caseTypes.find((c) => c.name === moduleCaseType);
		const property = ct?.properties.find((p) => p.name === input.property);
		const decl: SearchInputDecl = property?.data_type
			? { name: input.name, data_type: property.data_type }
			: { name: input.name };
		knownInputs.push(decl);
	}

	return {
		caseTypes: [...caseTypes],
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
