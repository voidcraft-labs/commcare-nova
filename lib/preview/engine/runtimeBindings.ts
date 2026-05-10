// lib/preview/engine/runtimeBindings.ts
//
// Runtime-bindings layer for the running-app case list. Translates
// per-input typed values into ONE `Predicate` that the helper layer
// (`readCases`) AND-composes with `caseListConfig.filter`.
//
// Pure module — no I/O, no `import "server-only"`, no `"use client"`
// directive — so server helpers AND client-side widgets can value-
// import one composition site without dragging the case-store's
// Cloud SQL graph through the client bundle.

import type {
	SearchInputDef,
	SearchInputMode,
	SearchInputType,
} from "@/lib/domain";
import type {
	Predicate,
	PropertyRef,
	SwitchCase,
	Term,
	ValueExpression,
} from "@/lib/domain/predicate";
import {
	between,
	dateLiteral,
	eq,
	literal,
	match,
	multiSelectAll,
	multiSelectAny,
	prop,
	reduceAnd,
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
 * and `<name>:to` for the upper bound. The widget emits both; this
 * module reads both. Picking colon-suffixed keys (rather than array
 * indices or a nested map) keeps the value bag's shape uniform —
 * every entry is `string → string`, debounce-driven client state
 * stays flat, and an empty bound is the same shape as an absent one
 * ("not present in the map").
 *
 * The named alias preserves the domain-role tag at every call site
 * (`inputValues: SearchInputValues` reads as the runtime-bindings
 * input bag, not as a generic string map) without inventing a
 * single-field wrapper.
 */
export type SearchInputValues = ReadonlyMap<string, string>;

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
	// `reduceAnd` returns the canonical sentinel for empty input
	// (`match-all`), unwraps a single clause, and signals "use the
	// n-ary form" with `undefined` — the same dispatch the `and`
	// builder runs internally. Routing through the reducer pins the
	// reduction contract to a single source of truth and avoids
	// re-creating the dispatch by hand.
	const reduced = reduceAnd(clauses);
	if (reduced !== undefined) return reduced;
	// Two-or-more clauses: construct the standard `and` envelope
	// directly. The cast through `as` mirrors `and`'s own
	// implementation site — TypeScript can't see the
	// `reduceAnd === undefined` guarantee that the array is
	// non-empty-with-second-element from inside this branch.
	return { kind: "and", clauses: clauses as [Predicate, ...Predicate[]] };
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
 * Dispatches on the full `SearchInputMode` object (not just its
 * `kind`) so the multi-select arm's `quantifier` slot narrows
 * naturally inside the switch — the discriminated-union arm carries
 * the slot at the type level. Absent `mode` falls back to the per-
 * `type` default via `defaultModeFor(type)`, matching the wire
 * layer's per-type default contract.
 *
 * Range mode is the only kind that reads two keys (`:from` / `:to`);
 * every other mode reads the bare `<input.name>` key.
 */
function buildSimpleArmClause(
	input: Extract<SearchInputDef, { kind: "simple" }>,
	inputValues: SearchInputValues,
	caseType: string,
): Predicate | undefined {
	const mode = input.mode ?? defaultModeFor(input.type);
	if (mode.kind === "range") {
		return buildRangeClause(input, inputValues, caseType);
	}

	const value = inputValues.get(input.name);
	if (value === undefined || value === "") return undefined;
	// Whitespace-only values pass through verbatim — the widget
	// layer trims before calling, so a non-empty string here is an
	// explicit value the user typed.

	const property = prop(caseType, input.property, input.via);
	switch (mode.kind) {
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
			// `mode` narrows to the multi-select arm here — its
			// `quantifier` slot is reachable directly without a cast.
			return buildMultiSelectClause(mode, property, value);
		default: {
			const _exhaustive: never = mode;
			throw new Error(
				unhandledKindMessage({
					where: "buildSimpleArmClause",
					family: "SearchInputMode",
					received: (_exhaustive as { kind?: unknown })?.kind ?? _exhaustive,
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
 * Empty list after split + trim + filter-empty → no clause for the
 * input. `multiSelectAny` / `multiSelectAll` require at least one
 * literal at the type level, so a zero-element spread would fail at
 * the call site; the early return is the structural defense.
 */
function buildMultiSelectClause(
	mode: Extract<SearchInputMode, { kind: "multi-select-contains" }>,
	property: PropertyRef,
	rawValue: string,
): Predicate | undefined {
	const tokens = rawValue
		.split(",")
		.map((token) => token.trim())
		.filter((token) => token.length > 0);
	if (tokens.length === 0) return undefined;
	const [first, ...rest] = tokens.map(literal);
	if (mode.quantifier === "all") {
		return multiSelectAll(property, first, ...rest);
	}
	return multiSelectAny(property, first, ...rest);
}

/**
 * Build a range clause: read `<name>:from` / `<name>:to`, gate each
 * bound's format, omit malformed / empty bounds, return `undefined`
 * if both are absent.
 *
 * Range mode applies to `date` / `date-range` inputs (see
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
	const lower = parseDateBound(inputValues.get(`${input.name}:from`));
	const upper = parseDateBound(inputValues.get(`${input.name}:to`));
	if (lower === undefined && upper === undefined) return undefined;
	// `between(...)` dispatches the lower / upper / both / neither
	// cascade itself, including the absent-not-undefined contract
	// that strips omitted bounds from the constructed shape. Routing
	// every bound permutation through the builder keeps the
	// construction-rule contract in one place.
	return between(prop(caseType, input.property, input.via), { lower, upper });
}

/**
 * Format-gate a single date bound. Treats malformed / empty values
 * as absent so a stale or partially-typed value (e.g. `2025-` while
 * the user is mid-edit) is filtered out before reaching the SQL
 * layer.
 *
 * Pattern matches the wire-form `YYYY-MM-DD` shape. Calendar
 * validity (month 13, February 30) is the SQL layer's concern —
 * Postgres rejects invalid calendar dates at the date cast inside
 * `compileLiteral`. This gate's job is the surface check that
 * catches mid-edit empty / partial values from the date input
 * widget; consumers handle anything else.
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
 * Mode kinds eligible to seed a per-`type` default — every kind
 * EXCEPT `multi-select-contains`. The exclusion is structural: the
 * multi-select arm requires a `quantifier` slot the default-table
 * can't supply, and no `APPLICABLE_SEARCH_MODES` row lists it first
 * anyway. Type-system enforcement of "the default table can never
 * point at multi-select" is more durable than a runtime narrowing
 * guard.
 */
type DefaultableModeKind = Exclude<
	SearchInputMode["kind"],
	"multi-select-contains"
>;

/**
 * Per-`type` default mode kind. Matches the head of each tuple in
 * `APPLICABLE_SEARCH_MODES` (`lib/domain/modules.ts`) — the test
 * suite pins the agreement so the two tables stay in lockstep
 * without coupling this construction site to a runtime table walk.
 */
const DEFAULT_SEARCH_MODE_KIND: Readonly<
	Record<SearchInputType, DefaultableModeKind>
> = {
	text: "exact",
	select: "exact",
	date: "exact",
	"date-range": "range",
	barcode: "exact",
};

/**
 * Per-`type` default `SearchInputMode`. Reads the kind off the
 * `DEFAULT_SEARCH_MODE_KIND` table and wraps it in a discriminator-
 * only mode object; the `multi-select-contains` arm (the only mode
 * carrying additional slots) is excluded by the table's value type.
 */
function defaultModeFor(type: SearchInputType): SearchInputMode {
	return { kind: DEFAULT_SEARCH_MODE_KIND[type] };
}

// ── Advanced arm ──────────────────────────────────────────────────

/**
 * Build the advanced-arm clause: when the value is non-empty,
 * recurse into `substituteInputInPredicate` to bind the input ref
 * at every value-position match. The walker functions below are
 * the authoritative site for arm-by-arm substitution semantics.
 */
function buildAdvancedArmClause(
	input: Extract<SearchInputDef, { kind: "advanced" }>,
	inputValues: SearchInputValues,
): Predicate | undefined {
	const value = inputValues.get(input.name);
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
			// `ValueExpression`.
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
			})) as [SwitchCase, ...SwitchCase[]];
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
