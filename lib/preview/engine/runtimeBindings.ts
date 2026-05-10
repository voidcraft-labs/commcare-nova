// lib/preview/engine/runtimeBindings.ts
//
// Runtime-bindings layer for the running-app case list. Translates the
// current per-input typed values into ONE `Predicate` that the helper
// layer (`readCases`) AND-composes with the always-on
// `caseListConfig.filter` slot before handing the unified predicate to
// `CaseStore.query(...)`. The unified-filter slot stays the single
// source for both the case-list always-on filter and the live search-
// input contributions — there is no parallel "search default filter"
// in the authoring layer.
//
// ## Why this lives outside the helpers module
//
// The helpers module (`./caseDataBindingHelpers.ts`) carries
// `import "server-only"` because it touches the `CaseStore` connector
// graph. The bindings layer touches NO I/O: it walks the typed AST
// against an in-memory map of `name → string` values. Keeping the
// composition pure lets server-only helpers AND client-side code
// (the upcoming `SearchInputForm` widget that needs to display the
// composed predicate's effect previewing locally, plus tests) value-
// import from one canonical site without dragging the case-store's
// Cloud SQL graph through the client bundle.
//
// ## Per-arm dispatch — what this module actually does
//
// For each `SearchInputDef`:
//
//   - `kind: "simple"` — value flows through `(property, mode, via)`
//     into a per-mode comparison built via the predicate AST builders.
//     The `mode` slot is a discriminated-union object; when absent,
//     the per-`type` first entry of `APPLICABLE_SEARCH_MODES` picks
//     the default. The mode's `kind` discriminator drives the
//     comparison shape (`exact` → `eq`, `fuzzy` → `match("fuzzy")`,
//     `range` → `between`, `multi-select-contains` → `multi-select-
//     contains` with the mode's quantifier, etc.).
//
//   - `kind: "advanced"` — the input's `predicate` AST is bound
//     against an `input(name)` term reference; the runtime walks the
//     AST and substitutes the value at every value-position
//     `input(name)` Term whose `name` matches THIS input's name.
//     Every other Term shape is left in place. The substitution
//     replaces `{ kind: "term", term: { kind: "input", name } }` with
//     `{ kind: "term", term: { kind: "literal", value } }` — a bare
//     string literal regardless of the input's declared `type`. Type
//     coercion is the wire / Postgres layer's concern; the AST
//     captures intent, not the destination type.
//
// ## Why the trigger slot on `whenInputPresent` is preserved
//
// The Predicate AST has a non-value `input` slot on
// `whenInputPresent.input` (typed `SearchInputRef`, not a value-
// position term). Replacing the trigger ref with a literal would
// violate that slot's schema discriminator and would also conflate
// the runtime-presence check with the runtime-value substitution.
// The trigger slot stays as-is; only value-position
// `{ kind: "term", term: { kind: "input", name } }` shapes are
// rewritten when `name` matches.
//
// ## Empty-value short-circuit + match-all identity
//
// Per-input contributions short-circuit on empty / absent values. The
// `range` mode reads `<input.name>:from` and `<input.name>:to` keys
// (the date-range widget at Plan 5 Task 3 emits both) and omits a
// bound that's empty / malformed; both bounds empty → the input
// contributes nothing. Multi-select values comma-split + trim +
// filter-empty; an empty list after the split → no clause for the
// input. When NO input contributes, the function returns `matchAll()`
// — the `and(...)` builder's reduction collapses a one-clause `and`
// to the lone clause and an empty `and` to `match-all`, so the helper
// layer can AND-compose unconditionally without a "did anything
// contribute" check.
//
// ## SearchInputDef.default — explicitly NOT honored here
//
// The schema carries an optional `default: ValueExpression` slot
// (`today()` for date-typed inputs, etc.). Honoring it requires a
// JS-side ValueExpression evaluator that doesn't exist today; the
// running-app surface ships with empty initial input values for v1.

import type {
	SearchInputDef,
	SearchInputMode,
	SearchInputType,
} from "@/lib/domain";
import { APPLICABLE_SEARCH_MODES } from "@/lib/domain";
import type { Predicate, Term, ValueExpression } from "@/lib/domain/predicate";
import {
	and,
	between,
	dateLiteral,
	eq,
	literal,
	match,
	matchAll,
	multiSelectAll,
	multiSelectAny,
	prop,
	term,
} from "@/lib/domain/predicate";
import { unhandledKindMessage } from "@/lib/domain/predicate/errors";

/**
 * Per-input value bag. Keys are search-input `name` slots; values are
 * the user's typed strings. An empty string OR absent key means the
 * user has not filled the input — per-input contributions short-
 * circuit to "no clause".
 *
 * Range-typed inputs use TWO keys: `<name>:from` for the lower bound
 * and `<name>:to` for the upper bound. The widget (Plan 5 Task 3)
 * emits both; this module reads both. Picking colon-suffixed keys
 * (rather than array indices or a nested map) keeps the value bag's
 * shape uniform — every entry is `string → string`, debounce-driven
 * client state stays flat, and an empty bound is the same shape as an
 * absent one ("not present in the map").
 */
export interface SearchInputValues {
	readonly values: ReadonlyMap<string, string>;
}

/**
 * Compose every contributing search-input's runtime predicate into
 * one Predicate. Caller-side AND-composition with
 * `caseListConfig.filter` happens at the helper layer (`readCases`)
 * so the unified-filter slot remains the single source for both the
 * case-list always-on filter and the search-input contributions.
 *
 * Empty / absent input values short-circuit at the per-input level —
 * the input contributes nothing. Zero-input or all-empty input
 * returns `matchAll()` (the conjunction identity element) so the
 * helper layer can AND-compose unconditionally without a "did
 * anything contribute" check.
 *
 * `caseType` threads to every `prop(caseType, property, via?)` Term
 * construction so the predicate compiler can resolve the property's
 * `data_type` against the case-type schema map at SQL emission.
 */
export function composeRuntimeFilter(
	searchInputs: ReadonlyArray<SearchInputDef>,
	inputValues: SearchInputValues,
	caseType: string,
): Predicate {
	const clauses: Predicate[] = [];
	for (const input of searchInputs) {
		const clause = clauseForInput(input, inputValues, caseType);
		if (clause !== undefined) clauses.push(clause);
	}
	// Per-arity dispatch through the `and(...)` overload set:
	//
	//   - zero clauses → `match-all` (conjunction identity)
	//   - one clause   → the lone clause unwrapped
	//   - two or more  → the standard `{ kind: "and", clauses }`
	//
	// The builder applies these reductions internally; calling
	// per-arity here picks the correctly-typed overload at the call
	// site rather than spreading through a `Predicate[]` (which would
	// erase the non-empty witness the variadic overload demands).
	if (clauses.length === 0) return and();
	if (clauses.length === 1) {
		// `clauses[0]` is provably defined (length-1 guard), but TS's
		// non-uncheckedIndexedAccess mode doesn't narrow array index
		// reads. Pull the value via destructuring for a non-undefined
		// type without a non-null assertion.
		const [only] = clauses;
		if (only === undefined) return matchAll();
		return and(only);
	}
	const [first, second, ...rest] = clauses;
	if (first === undefined || second === undefined) return matchAll();
	return and(first, second, ...rest);
}

// ── Per-arm dispatch ──────────────────────────────────────────────

/**
 * Build a single per-input clause, or return `undefined` if the input
 * contributes nothing (empty / absent value). Discriminates on the
 * input's `kind` and routes to the per-arm builder.
 */
function clauseForInput(
	input: SearchInputDef,
	inputValues: SearchInputValues,
	caseType: string,
): Predicate | undefined {
	switch (input.kind) {
		case "simple":
			return buildSimpleArmClause(input, inputValues, caseType);
		case "advanced":
			return buildAdvancedArmClause(input, inputValues);
		default: {
			const _exhaustive: never = input;
			throw new Error(
				unhandledKindMessage({
					where: "composeRuntimeFilter",
					family: "SearchInputDef",
					received: (_exhaustive as { kind?: unknown })?.kind ?? _exhaustive,
					knownKinds: ["simple", "advanced"],
				}),
			);
		}
	}
}

// ── Simple arm ────────────────────────────────────────────────────

/**
 * Build the simple-arm clause: `(property, mode, via)` → per-mode
 * comparison.
 *
 * The `mode` slot is a discriminated-union object; when absent, the
 * per-`type` first entry of `APPLICABLE_SEARCH_MODES` picks the
 * default. Routes through `defaultModeKindFor(input.type)` so the
 * runtime here matches the wire layer's per-type default.
 *
 * Range mode is the only kind that reads two keys (`:from` / `:to`);
 * every other mode reads the bare `<input.name>` key.
 */
function buildSimpleArmClause(
	input: Extract<SearchInputDef, { kind: "simple" }>,
	inputValues: SearchInputValues,
	caseType: string,
): Predicate | undefined {
	const modeKind = input.mode?.kind ?? defaultModeKindFor(input.type);
	if (modeKind === "range") {
		return buildRangeClause(input, inputValues, caseType);
	}

	const value = inputValues.values.get(input.name);
	if (value === undefined || value === "") return undefined;

	const property = prop(caseType, input.property, input.via);
	switch (modeKind) {
		case "exact":
			return eq(property, literal(value));
		case "fuzzy":
			return match(property, literal(value), "fuzzy");
		case "starts-with":
			return match(property, literal(value), "starts-with");
		case "phonetic":
			return match(property, literal(value), "phonetic");
		case "fuzzy-date":
			return match(property, literal(value), "fuzzy-date");
		case "multi-select-contains":
			return buildMultiSelectClause(input.mode, property, value);
		default: {
			const _exhaustive: never = modeKind;
			throw new Error(
				unhandledKindMessage({
					where: "buildSimpleArmClause",
					family: "SearchInputMode",
					received: _exhaustive,
					knownKinds: [
						"exact",
						"fuzzy",
						"starts-with",
						"phonetic",
						"fuzzy-date",
						"range",
						"multi-select-contains",
					],
				}),
			);
		}
	}
}

/**
 * Build the multi-select clause: comma-split the value into per-token
 * literals, route through the quantifier-specific builder.
 *
 * The quantifier lives on the mode object (`mode.quantifier`); `mode`
 * is only ever `multi-select-contains`-shaped here because the caller
 * dispatched on `mode.kind`. When `mode` is `undefined` the input was
 * relying on the per-type default — and no per-type default selects
 * `multi-select-contains`, so reaching this branch without a
 * `quantifier` is a type-checker bypass. The `?? "any"` fallback
 * keeps the runtime defensive without throwing — `any` is the wider
 * of the two quantifiers, matching CCHQ's default OR-of-`selected()`
 * shape on the on-device dialect.
 *
 * Empty list after split + trim + filter → no clause for the input.
 * `multiSelectAny` / `multiSelectAll` require at least one literal at
 * the type level, so a zero-element spread would fail at the call
 * site; the early return is the structural defense.
 */
function buildMultiSelectClause(
	mode: SearchInputMode | undefined,
	property: ReturnType<typeof prop>,
	rawValue: string,
): Predicate | undefined {
	const tokens = rawValue
		.split(",")
		.map((token) => token.trim())
		.filter((token) => token.length > 0);
	if (tokens.length === 0) return undefined;
	const [first, ...rest] = tokens.map((token) => literal(token));
	if (first === undefined) return undefined;
	const quantifier =
		mode !== undefined && mode.kind === "multi-select-contains"
			? mode.quantifier
			: "any";
	if (quantifier === "all") {
		return multiSelectAll(property, first, ...rest);
	}
	return multiSelectAny(property, first, ...rest);
}

/**
 * Build a range clause: read `<name>:from` / `<name>:to`, gate each
 * bound's format, omit malformed / empty bounds, return `undefined`
 * if both are absent.
 *
 * Range mode in v1 only applies to `date` / `date-range` inputs (see
 * `SEARCH_INPUT_TYPE_PROPERTY_TYPES` in `lib/domain/modules.ts`), so
 * each bound flows through `dateLiteral(...)` after the format check.
 * Non-`YYYY-MM-DD` strings would construct a typed-but-malformed
 * literal that fails downstream at SQL emission; gating here treats
 * malformed bounds as absent so a stale / partially-typed value
 * doesn't crash the query.
 */
function buildRangeClause(
	input: Extract<SearchInputDef, { kind: "simple" }>,
	inputValues: SearchInputValues,
	caseType: string,
): Predicate | undefined {
	const fromKey = `${input.name}:from`;
	const toKey = `${input.name}:to`;
	const fromRaw = inputValues.values.get(fromKey);
	const toRaw = inputValues.values.get(toKey);
	const lower = parseDateBound(fromRaw);
	const upper = parseDateBound(toRaw);
	if (lower === undefined && upper === undefined) return undefined;

	const property = prop(caseType, input.property, input.via);
	if (lower !== undefined && upper !== undefined) {
		return between(property, { lower, upper });
	}
	if (lower !== undefined) {
		return between(property, { lower });
	}
	// `upper` defined; `lower` undefined.
	return between(property, { upper });
}

/**
 * Format-gate a single date bound. Treats malformed / empty values as
 * absent so a stale or partially-typed value (e.g. `2025-` while the
 * user is mid-edit) is filtered out before reaching the SQL layer.
 *
 * Pattern matches CommCare's wire-form `YYYY-MM-DD`. Stricter
 * calendar-validity checks (month 13, February 30) live at the wire-
 * emission boundary; this module's job is to keep obviously broken
 * shapes from crashing the query.
 *
 * Returns a `ValueExpression` (the `term`-wrapped literal) so the
 * caller can splice the result directly into `between`'s
 * `lower` / `upper` slots without an extra wrap. Returns `undefined`
 * when the bound is empty / malformed.
 */
const ISO_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
function parseDateBound(raw: string | undefined): ValueExpression | undefined {
	if (raw === undefined || raw === "") return undefined;
	if (!ISO_DATE_PATTERN.test(raw)) return undefined;
	return term(dateLiteral(raw));
}

/**
 * Per-`type` default `mode.kind`. The first entry of
 * `APPLICABLE_SEARCH_MODES[type]` is canonical — same source the wire
 * layer reads. The `as const` widening of the array entry makes the
 * return type the discriminator value the caller switches on.
 */
function defaultModeKindFor(type: SearchInputType): SearchInputMode["kind"] {
	const modes = APPLICABLE_SEARCH_MODES[type];
	const first = modes[0];
	if (first === undefined) {
		// Unreachable: every `SearchInputType` carries a non-empty
		// applicability tuple. Surfaces as an internal-bug message
		// rather than silently picking a fallback that could mask a
		// future divergence between the type set and the table.
		throw new Error(
			unhandledKindMessage({
				where: "defaultModeKindFor",
				family: "SearchInputType",
				received: type,
				knownKinds: Object.keys(APPLICABLE_SEARCH_MODES),
			}),
		);
	}
	return first;
}

// ── Advanced arm ──────────────────────────────────────────────────

/**
 * Build the advanced-arm clause: substitute the input's value at
 * every value-position `input(name)` Term whose `name` matches THIS
 * input's name, leaving every other Term shape in place.
 *
 * Empty / absent value → no clause for this input (early return
 * before substitution). Substitution replaces
 * `{ kind: "term", term: { kind: "input", name } }` with
 * `{ kind: "term", term: { kind: "literal", value } }` — a bare
 * string literal regardless of the input's declared `type`. Type
 * coercion is the wire / Postgres layer's job.
 *
 * Orphan `input(other)` references (a different input's name) and
 * the trigger slot of `whenInputPresent` are preserved untouched —
 * Plan 4's validator caught structurally-orphan refs at parse time,
 * and the `whenInputPresent.input` slot is structurally a
 * `SearchInputRef`, not a value-position term.
 */
function buildAdvancedArmClause(
	input: Extract<SearchInputDef, { kind: "advanced" }>,
	inputValues: SearchInputValues,
): Predicate | undefined {
	const value = inputValues.values.get(input.name);
	if (value === undefined || value === "") return undefined;
	return substituteInputInPredicate(input.predicate, input.name, value);
}

// ── Advanced-arm AST rewriter ────────────────────────────────────
//
// Recursive substitution over the `Predicate` / `ValueExpression` /
// `Term` unions. Every value-position `{ kind: "term", term: { kind:
// "input", name } }` whose `name` matches the target is rewritten to
// a literal-bearing `term` arm; every other shape is rebuilt
// structurally (so the rewriter is a fresh tree, not a mutation of
// the input AST — the input AST is treated as read-only).
//
// Why a fresh tree: Predicates are persisted in Firestore alongside
// the blueprint document. Mutating a node would mutate the saved
// AST in-place; the doc store's zundo undo/redo machinery relies on
// reference equality to detect changes, and an in-place mutation
// would corrupt the history. Rebuilding is structural and cheap —
// every consumer ships a tree-walker shape regardless.

/**
 * Walk a `Predicate` and substitute matching `input(name)` value-
 * position terms. Every operator arm rebuilds its slots so the
 * returned tree shares no nodes with the input AST below the root.
 */
function substituteInputInPredicate(
	predicate: Predicate,
	targetName: string,
	value: string,
): Predicate {
	switch (predicate.kind) {
		case "match-all":
		case "match-none":
			return predicate;
		case "eq":
		case "neq":
		case "gt":
		case "gte":
		case "lt":
		case "lte":
			return {
				kind: predicate.kind,
				left: substituteInputInExpression(predicate.left, targetName, value),
				right: substituteInputInExpression(predicate.right, targetName, value),
			};
		case "in": {
			const left = substituteInputInExpression(
				predicate.left,
				targetName,
				value,
			);
			// `in.values` is literal-only at the schema layer; literals
			// carry no input refs, so the values list passes through
			// unchanged. Rebuilding the array shape with the original
			// references is sufficient.
			return { kind: "in", left, values: predicate.values };
		}
		case "within-distance":
			return {
				kind: "within-distance",
				property: predicate.property,
				center: substituteInputInExpression(
					predicate.center,
					targetName,
					value,
				),
				distance: predicate.distance,
				unit: predicate.unit,
			};
		case "match":
			// `match.value` is a `ValueExpression` slot; recurse so a
			// match value driven by a search-input substitutes cleanly.
			// `match.property` is a `PropertyRef`, structurally a `prop`
			// Term — it carries no input ref.
			return {
				kind: "match",
				property: predicate.property,
				value: substituteInputInExpression(predicate.value, targetName, value),
				mode: predicate.mode,
			};
		case "multi-select-contains":
			// Same shape as `in.values` — literal-only by schema, so the
			// values list passes through unchanged.
			return {
				kind: "multi-select-contains",
				property: predicate.property,
				values: predicate.values,
				quantifier: predicate.quantifier,
			};
		case "between": {
			const base = {
				kind: "between" as const,
				left: substituteInputInExpression(predicate.left, targetName, value),
				lowerInclusive: predicate.lowerInclusive,
				upperInclusive: predicate.upperInclusive,
			};
			// Mirror `between`'s absent-not-undefined contract — Zod's
			// `.optional()` strips absent keys on parse, so a builder
			// that materialized `lower: undefined` would silently break
			// the round-trip equality assertions consumers rely on.
			if (predicate.lower !== undefined && predicate.upper !== undefined) {
				return {
					...base,
					lower: substituteInputInExpression(
						predicate.lower,
						targetName,
						value,
					),
					upper: substituteInputInExpression(
						predicate.upper,
						targetName,
						value,
					),
				};
			}
			if (predicate.lower !== undefined) {
				return {
					...base,
					lower: substituteInputInExpression(
						predicate.lower,
						targetName,
						value,
					),
				};
			}
			if (predicate.upper !== undefined) {
				return {
					...base,
					upper: substituteInputInExpression(
						predicate.upper,
						targetName,
						value,
					),
				};
			}
			return base;
		}
		case "is-null":
			return {
				kind: "is-null",
				left: substituteInputInExpression(predicate.left, targetName, value),
			};
		case "is-blank":
			return {
				kind: "is-blank",
				left: substituteInputInExpression(predicate.left, targetName, value),
			};
		case "and":
			return {
				kind: "and",
				clauses: rebuildClauseTuple(predicate.clauses, targetName, value),
			};
		case "or":
			return {
				kind: "or",
				clauses: rebuildClauseTuple(predicate.clauses, targetName, value),
			};
		case "not":
			return {
				kind: "not",
				clause: substituteInputInPredicate(predicate.clause, targetName, value),
			};
		case "when-input-present":
			// `whenInputPresent.input` is the trigger slot — typed
			// `SearchInputRef`, NOT a value-position term. Replacing it
			// with a literal would violate that slot's discriminator and
			// also conflate the runtime-presence check with the runtime-
			// value substitution (the validator rule on this operator
			// gates the whole subtree on the trigger's presence at
			// runtime, regardless of what value the input carries). The
			// trigger ref is preserved as-is; only the inner clause is
			// recursed into.
			return {
				kind: "when-input-present",
				input: predicate.input,
				clause: substituteInputInPredicate(predicate.clause, targetName, value),
			};
		case "exists":
			return predicate.where === undefined
				? { kind: "exists", via: predicate.via }
				: {
						kind: "exists",
						via: predicate.via,
						where: substituteInputInPredicate(
							predicate.where,
							targetName,
							value,
						),
					};
		case "missing":
			return predicate.where === undefined
				? { kind: "missing", via: predicate.via }
				: {
						kind: "missing",
						via: predicate.via,
						where: substituteInputInPredicate(
							predicate.where,
							targetName,
							value,
						),
					};
		default: {
			const _exhaustive: never = predicate;
			throw new Error(
				unhandledKindMessage({
					where: "substituteInputInPredicate",
					family: "Predicate",
					received: (_exhaustive as { kind?: unknown })?.kind ?? _exhaustive,
					knownKinds: [
						"match-all",
						"match-none",
						"and",
						"or",
						"not",
						"eq",
						"neq",
						"gt",
						"gte",
						"lt",
						"lte",
						"in",
						"between",
						"multi-select-contains",
						"match",
						"within-distance",
						"is-null",
						"is-blank",
						"when-input-present",
						"exists",
						"missing",
					],
				}),
			);
		}
	}
}

/**
 * Rebuild a non-empty clause tuple — `and.clauses` / `or.clauses`
 * carry the tuple-with-rest shape `[Predicate, ...Predicate[]]` per
 * the schema. Mapping over the array preserves the non-empty witness:
 * the caller hands in a tuple, every entry maps to a Predicate, and
 * the result is the same length. The cast is unavoidable because
 * `Array.prototype.map` widens the return type to `Predicate[]`; the
 * `as` is structurally safe and mirrors the same cast site in
 * `builders.ts::and`.
 */
function rebuildClauseTuple(
	clauses: readonly [Predicate, ...Predicate[]],
	targetName: string,
	value: string,
): [Predicate, ...Predicate[]] {
	return clauses.map((clause) =>
		substituteInputInPredicate(clause, targetName, value),
	) as [Predicate, ...Predicate[]];
}

/**
 * Walk a `ValueExpression` and substitute matching `input(name)`
 * value-position terms. Every arm rebuilds its slots so the returned
 * tree shares no nodes with the input AST below the root.
 */
function substituteInputInExpression(
	expr: ValueExpression,
	targetName: string,
	value: string,
): ValueExpression {
	switch (expr.kind) {
		case "term":
			return substituteInputInTerm(expr.term, targetName, value);
		case "today":
		case "now":
			return expr;
		case "date-add":
			return {
				kind: "date-add",
				date: substituteInputInExpression(expr.date, targetName, value),
				interval: expr.interval,
				quantity: substituteInputInExpression(expr.quantity, targetName, value),
			};
		case "date-coerce":
			return {
				kind: "date-coerce",
				value: substituteInputInExpression(expr.value, targetName, value),
			};
		case "datetime-coerce":
			return {
				kind: "datetime-coerce",
				value: substituteInputInExpression(expr.value, targetName, value),
			};
		case "double":
			return {
				kind: "double",
				value: substituteInputInExpression(expr.value, targetName, value),
			};
		case "arith":
			return {
				kind: "arith",
				op: expr.op,
				left: substituteInputInExpression(expr.left, targetName, value),
				right: substituteInputInExpression(expr.right, targetName, value),
			};
		case "concat": {
			const parts = expr.parts.map((part) =>
				substituteInputInExpression(part, targetName, value),
			) as [ValueExpression, ...ValueExpression[]];
			return { kind: "concat", parts };
		}
		case "coalesce": {
			const values = expr.values.map((v) =>
				substituteInputInExpression(v, targetName, value),
			) as [ValueExpression, ...ValueExpression[]];
			return { kind: "coalesce", values };
		}
		case "if":
			// `if.cond` is a `Predicate` (cross-family) — recurse via the
			// predicate-side rewriter so a search-input drives a
			// conditional's condition cleanly. Both branches are
			// `ValueExpression`. The `then` slot's `noThenProperty` Biome
			// suppression mirrors the source-of-truth rationale on
			// `ifSchema.then` in the AST package — `then` holds a
			// non-callable AST object, never a thenable function.
			return {
				kind: "if",
				cond: substituteInputInPredicate(expr.cond, targetName, value),
				// biome-ignore lint/suspicious/noThenProperty: AST shape mirrors `ifSchema`; `then` holds a ValueExpression object, never a callable. Full thenable-hazard analysis lives on `ifSchema` in `lib/domain/predicate/types.ts`.
				then: substituteInputInExpression(expr.then, targetName, value),
				else: substituteInputInExpression(expr.else, targetName, value),
			};
		case "switch": {
			// `switch.cases[].when` is a `Literal` — literals carry no
			// input refs, so the `when` slot passes through unchanged.
			// `switch.cases[].then` is a `ValueExpression` and recurses.
			const cases = expr.cases.map((c) => ({
				when: c.when,
				// biome-ignore lint/suspicious/noThenProperty: AST shape mirrors `switchCaseSchema`; `then` holds a ValueExpression object, never a callable.
				then: substituteInputInExpression(c.then, targetName, value),
			})) as [
				{ when: (typeof expr.cases)[0]["when"]; then: ValueExpression },
				...{ when: (typeof expr.cases)[0]["when"]; then: ValueExpression }[],
			];
			return {
				kind: "switch",
				on: substituteInputInExpression(expr.on, targetName, value),
				cases,
				fallback: substituteInputInExpression(expr.fallback, targetName, value),
			};
		}
		case "count":
			// `count.where` is a `Predicate` (cross-family). The `via`
			// slot is a `RelationPath` (no value slots).
			return expr.where === undefined
				? { kind: "count", via: expr.via }
				: {
						kind: "count",
						via: expr.via,
						where: substituteInputInPredicate(expr.where, targetName, value),
					};
		case "unwrap-list":
			return {
				kind: "unwrap-list",
				value: substituteInputInExpression(expr.value, targetName, value),
			};
		case "format-date":
			return {
				kind: "format-date",
				date: substituteInputInExpression(expr.date, targetName, value),
				pattern: expr.pattern,
			};
		default: {
			const _exhaustive: never = expr;
			throw new Error(
				unhandledKindMessage({
					where: "substituteInputInExpression",
					family: "ValueExpression",
					received: (_exhaustive as { kind?: unknown })?.kind ?? _exhaustive,
					knownKinds: [
						"term",
						"today",
						"now",
						"date-add",
						"date-coerce",
						"datetime-coerce",
						"double",
						"arith",
						"concat",
						"coalesce",
						"if",
						"switch",
						"count",
						"unwrap-list",
						"format-date",
					],
				}),
			);
		}
	}
}

/**
 * Substitute a Term whose kind is `input` and whose `name` matches
 * the target, leaving every other Term shape unchanged. Returns a
 * `ValueExpression` (the `term` arm is the structural lifter consumed
 * by every value slot) so the caller can splice the result into a
 * value position regardless of whether substitution fired.
 *
 * The parameter is named `node` (not `term`) to avoid shadowing the
 * `term` builder import at the file's top — foundation code
 * structurally prevents shadowing footguns rather than relying on
 * "the shadow is currently safe" to hold across edits.
 */
function substituteInputInTerm(
	node: Term,
	targetName: string,
	value: string,
): ValueExpression {
	switch (node.kind) {
		case "input":
			// Match-target check: substitute only when the input ref's
			// `name` matches THIS input's name. Orphan `input(other)`
			// references (a different input's name) are preserved
			// untouched — the validator caught structurally-orphan refs
			// at parse time, and value-position refs to a SIBLING input
			// in the same screen are this input's neighbor's job to
			// substitute when the runtime composes that input's clause.
			if (node.name === targetName) {
				return { kind: "term", term: { kind: "literal", value } };
			}
			return { kind: "term", term: node };
		case "prop":
		case "session-user":
		case "session-context":
		case "literal":
			return { kind: "term", term: node };
		default: {
			const _exhaustive: never = node;
			throw new Error(
				unhandledKindMessage({
					where: "substituteInputInTerm",
					family: "Term",
					received: (_exhaustive as { kind?: unknown })?.kind ?? _exhaustive,
					knownKinds: [
						"prop",
						"input",
						"session-user",
						"session-context",
						"literal",
					],
				}),
			);
		}
	}
}
