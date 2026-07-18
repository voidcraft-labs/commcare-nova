/**
 * Shared helpers for case-list-config validation rules.
 *
 * Two cross-cutting concerns live here:
 *
 *   1. **Property resolution** — every case-list-config rule that
 *      reads a property by name routes through the same admission
 *      set, so a property that exists for one rule exists for
 *      every rule and vice versa. Single source of truth at
 *      `validationContextFor(doc)` below: one memoized augmented
 *      case-type list per `BlueprintDoc` reference, consumed by
 *      every consumer (per-rule resolvers + the predicate AST type
 *      checker via `moduleTypeContext`).
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
 * The admission set IS the domain's effective case-type view —
 * `lib/domain/effectiveCaseTypes.ts::effectiveCaseTypes(doc)`: declared
 * properties (with writer-derived `data_type` filled where the
 * declaration is silent), the CommCare standard set, and writer-derived
 * entries, in that priority order. The builder workspace consumes the
 * SAME function for its verdicts and pickers, which is what keeps the
 * gate and the UI structurally unable to disagree about what a
 * property is.
 *
 * A property whose type nothing resolves carries `data_type: undefined`
 * in the view (honest unknown). The `resolvePropertyDataType` helper
 * below still collapses that to `"text"` via `effectiveDataType` —
 * the value-semantics convention the type checker, search-input
 * rules, and sort derivation share. Rules that must distinguish
 * unknown from text (`columnKindPropertyType`) read the entry's raw
 * `data_type` off the view instead.
 *
 * Every case-list-config rule consults this same admission set:
 *
 *   - `columnReferences` — `propertyExists` (existence only; no type
 *     check). Skips calculated columns (no `field` slot — their
 *     property references live inside the expression AST).
 *   - `searchInputModeMatchesPropertyType` — `resolvePropertyDataType`
 *     for `SEARCH_MODE_PROPERTY_TYPES` admission on simple inputs;
 *     advanced inputs delegate to the predicate AST type checker.
 *   - `filterTypeCheck` / `calculatedColumnTypeCheck` — delegate to
 *     `checkPredicate` / `checkValueExpression`, which resolve only
 *     against `ct.properties[]`. Routing through `moduleTypeContext`
 *     supplies the augmented list so writer-derived + standard
 *     properties resolve to their effective data types as if
 *     declared. This keeps the predicate-AST type checker
 *     semantically aligned with the case-store runtime (which
 *     accepts every property the case-store actually emits) without
 *     modifying the type checker itself.
 *
 * ## Memoization
 *
 * The effective admission set is memoized per `BlueprintDoc` reference inside
 * `effectiveCaseTypes`; this module memoizes its canonical compatibility
 * projection on the same identity. The doc store replaces the doc reference on
 * every mutation, so neither cache can become stale.
 */

import {
	authorableCaseProperties,
	type BlueprintDoc,
	type CaseProperty,
	type CaseType,
	LEGACY_STANDARD_CASE_PROPERTY_ALIASES,
	type Module,
	SEARCH_INPUT_RUNTIME_VALUE_TYPES,
} from "@/lib/domain";
import {
	type CasePropertyDataType,
	effectiveDataType,
} from "@/lib/domain/casePropertyTypes";
import { effectiveCaseTypes } from "@/lib/domain/effectiveCaseTypes";
import type {
	CheckPath,
	SearchInputDecl,
	TypeContext,
} from "@/lib/domain/predicate";

/**
 * Per-doc validation context. Carries the augmented case-type list —
 * the rule-set-wide property admission set, which IS the domain's
 * effective case-type view (declared + standard + writer-derived,
 * with writer-derived `data_type`s resolved and honest-unknown kept
 * absent — see `lib/domain/effectiveCaseTypes.ts`). Consumers route
 * every property lookup through this list so the priority order has
 * exactly one structural home.
 */
export interface ValidationContext {
	readonly augmentedCaseTypes: readonly CaseType[];
}

const VALIDATION_CONTEXT_CACHE = new WeakMap<BlueprintDoc, ValidationContext>();

/**
 * The `ValidationContext` for the doc. The admission set itself is
 * memoized per doc reference inside `effectiveCaseTypes`; the canonical alias
 * projection is memoized here on the same document identity.
 */
export function validationContextFor(doc: BlueprintDoc): ValidationContext {
	const cached = VALIDATION_CONTEXT_CACHE.get(doc);
	if (cached !== undefined) return cached;

	const context = {
		augmentedCaseTypes: effectiveCaseTypes(doc).map((caseType) => ({
			...caseType,
			properties: canonicalPropertiesForValidation(caseType.properties),
		})),
	};
	VALIDATION_CONTEXT_CACHE.set(doc, context);
	return context;
}

/**
 * Collapse CCHQ compatibility spellings onto Nova's canonical property
 * metadata before validation reads the catalog. The wire emitter maps, for
 * example, `name` to `case_name`; allowing a stale declared `name.data_type`
 * to win here would therefore validate one value while emitting another.
 *
 * Compatibility aliases are added back as lookup-only mirrors of the
 * canonical records. That keeps old blueprints and stored predicate ASTs
 * readable without letting their stale alias metadata become a second source
 * of truth. Authoring surfaces consume `authorableCaseProperties` directly and
 * never see these mirrors.
 */
function canonicalPropertiesForValidation(
	properties: readonly CaseProperty[],
): CaseProperty[] {
	const canonical = [...authorableCaseProperties(properties)];
	const canonicalByName = new Map(
		canonical.map((property) => [property.name, property]),
	);

	for (const [alias, canonicalName] of Object.entries(
		LEGACY_STANDARD_CASE_PROPERTY_ALIASES,
	)) {
		const property = canonicalByName.get(canonicalName);
		if (property !== undefined) canonical.push({ ...property, name: alias });
	}

	return canonical;
}

/**
 * Build the `TypeContext` a per-module type-checker call runs against.
 *
 * `caseTypes` is the augmented case-type list from the cached
 * `ValidationContext`, so the predicate AST type checker resolves
 * writer-derived + standard properties as if declared on
 * `ct.properties[]`. Rules that delegate to the type checker
 * (`filterTypeCheck`, `calculatedColumnTypeCheck`) thus consume the
 * same admission set as the per-rule property resolvers
 * (`searchInputModeMatchesPropertyType`, `columnReferences`).
 *
 * `knownInputs` is derived from each input's widget type through
 * `SEARCH_INPUT_RUNTIME_VALUE_TYPES`. This models what `input(name)` reads at
 * runtime, independent of authoring arm or target property: date widgets bind
 * dates; text/select/barcode widgets bind text; date-range widgets bind the
 * encoded `__range__<from>__<to>` text scalar. A simple date input targeting a
 * datetime property still reads as date, and an advanced date input is not
 * silently widened to text merely because it has no target property.
 *
 * `currentCaseType` is set to the module's case type so the
 * relational quantifiers (`exists` / `missing`) and the destination-
 * scope pin inside their `where` clauses can resolve property
 * references against the surrounding `via`'s destination scope.
 */
export function moduleTypeContext(mod: Module, doc: BlueprintDoc): TypeContext {
	const inputs = mod.caseListConfig?.searchInputs ?? [];
	const moduleCaseType = mod.caseType;
	const { augmentedCaseTypes } = validationContextFor(doc);

	const knownInputs: SearchInputDecl[] = inputs.map((input) => ({
		name: input.name,
		data_type: SEARCH_INPUT_RUNTIME_VALUE_TYPES[input.type],
	}));

	return {
		// `TypeContext.caseTypes` is typed as a mutable array
		// (`CaseType[]`) by the predicate-AST type checker. The
		// validation context's `augmentedCaseTypes` is `readonly` so it
		// can be safely shared across rules — copy into a fresh mutable
		// array at the boundary. The contents (the `CaseType` objects
		// themselves) stay shared by reference.
		caseTypes: [...augmentedCaseTypes],
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
 * declared → standard → writer-derived. The order is encoded once,
 * in `augmentCaseType` below; this resolver is a thin lookup
 * against the augmented list.
 */
export function resolvePropertyDataType(
	doc: BlueprintDoc,
	caseType: string,
	propertyName: string,
): CasePropertyDataType | undefined {
	const { augmentedCaseTypes } = validationContextFor(doc);
	return lookupInAugmented(augmentedCaseTypes, caseType, propertyName);
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
): boolean {
	return resolvePropertyDataType(doc, caseType, propertyName) !== undefined;
}

// ── Internal helpers ─────────────────────────────────────────────

/**
 * Look up a property's effective data type in an already-augmented
 * case-type list. The augmented list IS the admission set (every
 * arm of the priority order is flattened into each `ct.properties[]`
 * by `augmentCaseType`), so this is a two-level lookup: case-type
 * by name, then property by name on the matched case type. Returns
 * `undefined` when either lookup misses.
 */
function lookupInAugmented(
	augmented: readonly CaseType[],
	caseType: string,
	propertyName: string,
): CasePropertyDataType | undefined {
	const ct = augmented.find((c) => c.name === caseType);
	const property = ct?.properties.find((p) => p.name === propertyName);
	return property ? effectiveDataType(property) : undefined;
}
