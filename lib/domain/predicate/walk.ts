/**
 * Term-collecting AST walkers over the `Predicate` and
 * `ValueExpression` discriminated unions.
 *
 * The type checker (`./typeChecker`) walks the same shapes for type
 * resolution and per-operator semantic rules; consumers that need
 * structural collection (validator rules looking for property
 * references / search-input references; reducers that count operator
 * occurrences; rewriters that rebuild trees) need a separate-purpose
 * walker that visits every leaf without doing the type-resolution
 * work. Hand-rolling the recursion at every consumer would duplicate
 * the operator-arm case shapes — every new arm added to either union
 * (or to a sub-schema like `existsSchema.where`) would force every
 * consumer to add a parallel branch, with silent-miscompilation
 * potential when the consumer forgets.
 *
 * The visitors below centralize the recursion into one canonical
 * site. Each operator arm is enumerated exactly once; the
 * exhaustiveness assertion at every `default:` forces a TypeScript
 * compile error when a new arm lands without a parallel branch here.
 *
 * ## Visitor contract
 *
 * `walkTerms` receives one callback that fires for every `Term`
 * leaf reached anywhere in the predicate tree. Term arms are the
 * leaf family (`prop` / `input` / `session-user` / `session-context`
 * / `literal`) — no further recursion happens once a Term is hit.
 * Sub-AST property references (the `property: PropertyRef` slot on
 * `within-distance` / `match` / `multi-select-contains`) surface to
 * the visitor as a `prop`-kinded Term so consumers don't have to
 * inspect non-Term slots separately.
 *
 * The visitor is invoked for side effects — it returns `void`. Pure
 * (no I/O); the caller closes over its own accumulator.
 */

import type {
	Predicate,
	PropertyRef,
	SearchInputRef,
	Term,
	ValueExpression,
} from "./types";

/**
 * Visit every `Term` reached anywhere inside `predicate`. The
 * visitor fires once per Term leaf; ValueExpression operands and
 * nested Predicate clauses are recursed into without invoking the
 * visitor on the wrapper node itself.
 *
 * Each `PropertyRef` slot on `within-distance` / `match` /
 * `multi-select-contains` flows to the visitor as a `prop`-kinded
 * Term — structurally identical to the `prop()` Term constructed
 * via the builder. Consumers wanting "every property reference,
 * regardless of how it's spelled" filter the visitor to
 * `term.kind === "prop"` and read the result uniformly.
 */
export function walkTerms(
	predicate: Predicate,
	visit: (term: Term) => void,
): void {
	walkPredicate(predicate, visit);
}

/**
 * Visit every `Term` reached anywhere inside `expression`. Same
 * visitor contract as `walkTerms`, but rooted at a `ValueExpression`
 * instead of a `Predicate`. Used by consumers that walk
 * `ValueExpression`-rooted slots (e.g. the `excludedOwnerIds`
 * advanced-cluster slot, calculated columns) for the same
 * cross-family Term enumeration the predicate walker provides.
 */
export function walkExpressionTerms(
	expression: ValueExpression,
	visit: (term: Term) => void,
): void {
	walkValueExpression(expression, visit);
}

/**
 * Convenience wrapper: visit every `SearchInputRef` (i.e. every
 * `input(...)` Term) reached anywhere inside `predicate`. Filters
 * `walkTerms` to `kind === "input"` so consumers that only care
 * about input-ref resolution don't need to write the kind guard
 * themselves.
 */
export function walkInputRefs(
	predicate: Predicate,
	visit: (ref: SearchInputRef) => void,
): void {
	walkTerms(predicate, (term) => {
		if (term.kind === "input") visit(term);
	});
}

/**
 * Convenience wrapper: visit every `PropertyRef` (i.e. every
 * `prop(...)` Term and every operator slot typed `PropertyRef`)
 * reached anywhere inside `predicate`. Filters `walkTerms` to
 * `kind === "prop"`.
 */
export function walkPropertyRefs(
	predicate: Predicate,
	visit: (ref: PropertyRef) => void,
): void {
	walkTerms(predicate, (term) => {
		if (term.kind === "prop") visit(term);
	});
}

// ── Internal recursion ────────────────────────────────────────────

/**
 * Recursive descent over the `Predicate` union. Every operator arm
 * either dispatches to its operand walks (`walkValueExpression` for
 * ValueExpression slots, `walkPredicate` for nested predicate
 * slots) or pushes its `PropertyRef` slot directly through the
 * visitor. The exhaustiveness assertion at `default:` forces every
 * new operator arm to either get its own branch here or be
 * explicitly forwarded.
 */
function walkPredicate(
	predicate: Predicate,
	visit: (term: Term) => void,
): void {
	switch (predicate.kind) {
		case "match-all":
		case "match-none":
			return;
		case "eq":
		case "neq":
		case "gt":
		case "gte":
		case "lt":
		case "lte":
			walkValueExpression(predicate.left, visit);
			walkValueExpression(predicate.right, visit);
			return;
		case "in":
			walkValueExpression(predicate.left, visit);
			// `in.values` is `[Literal, ...Literal[]]` — literal Terms
			// surface to the visitor uniformly with every other Term leaf.
			for (const lit of predicate.values) visit(lit);
			return;
		case "within-distance":
			// `property` is a `PropertyRef` slot, structurally identical
			// to a `prop`-kinded Term — surface it through the same path.
			visit(predicate.property);
			walkValueExpression(predicate.center, visit);
			return;
		case "match":
			visit(predicate.property);
			// `match.value` is a `ValueExpression` (per `matchSchema`),
			// not a bare literal — the type checker admits term-arm
			// shapes including `term(input(...))` / `term(session-*(...))`,
			// and the simple-arm derivation pipeline at
			// `lib/commcare/suite/case-search/simpleArmDerivation.ts`
			// constructs exactly that shape for fuzzy / phonetic /
			// starts-with / fuzzy-date modes. Walking the value here
			// surfaces every Term ref a consumer (instance accumulator,
			// validator, defense-in-depth assertion) needs to see.
			walkValueExpression(predicate.value, visit);
			return;
		case "multi-select-contains":
			visit(predicate.property);
			for (const lit of predicate.values) visit(lit);
			return;
		case "is-null":
		case "is-blank":
			walkValueExpression(predicate.left, visit);
			return;
		case "between":
			walkValueExpression(predicate.left, visit);
			if (predicate.lower !== undefined)
				walkValueExpression(predicate.lower, visit);
			if (predicate.upper !== undefined)
				walkValueExpression(predicate.upper, visit);
			return;
		case "and":
		case "or":
			for (const clause of predicate.clauses) walkPredicate(clause, visit);
			return;
		case "not":
			walkPredicate(predicate.clause, visit);
			return;
		case "when-input-present":
			// The trigger ref is itself a Term (specifically a
			// `SearchInputRef`); fire the visitor on it so consumers see
			// every input ref the predicate carries, including the
			// trigger.
			visit(predicate.input);
			walkPredicate(predicate.clause, visit);
			return;
		case "exists":
		case "missing":
			if (predicate.where !== undefined) walkPredicate(predicate.where, visit);
			return;
		default: {
			const _exhaustive: never = predicate;
			throw new Error(
				`walkTerms: unhandled predicate kind ${String(_exhaustive)}`,
			);
		}
	}
}

/**
 * Recursive descent over the `ValueExpression` union. Each arm
 * either dispatches to its operand walks or terminates at a `term`
 * arm by firing the visitor on the wrapped Term.
 */
function walkValueExpression(
	expr: ValueExpression,
	visit: (term: Term) => void,
): void {
	switch (expr.kind) {
		case "term":
			visit(expr.term);
			return;
		case "today":
		case "now":
			return;
		case "date-add":
			walkValueExpression(expr.date, visit);
			walkValueExpression(expr.quantity, visit);
			return;
		case "date-coerce":
		case "datetime-coerce":
		case "double":
		case "unwrap-list":
			walkValueExpression(expr.value, visit);
			return;
		case "format-date":
			walkValueExpression(expr.date, visit);
			return;
		case "arith":
			walkValueExpression(expr.left, visit);
			walkValueExpression(expr.right, visit);
			return;
		case "concat":
			for (const part of expr.parts) walkValueExpression(part, visit);
			return;
		case "coalesce":
			for (const v of expr.values) walkValueExpression(v, visit);
			return;
		case "if":
			walkPredicate(expr.cond, visit);
			walkValueExpression(expr.then, visit);
			walkValueExpression(expr.else, visit);
			return;
		case "switch":
			walkValueExpression(expr.on, visit);
			for (const c of expr.cases) walkValueExpression(c.then, visit);
			walkValueExpression(expr.fallback, visit);
			return;
		case "count":
			if (expr.where !== undefined) walkPredicate(expr.where, visit);
			return;
		default: {
			const _exhaustive: never = expr;
			throw new Error(
				`walkTerms: unhandled value expression kind ${String(_exhaustive)}`,
			);
		}
	}
}
