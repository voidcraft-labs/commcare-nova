// lib/domain/predicate/simplify.ts
//
// Deep boolean-identity simplification for the WIRE-EMISSION boundary.
//
// `reduceAnd` / `reduceOr` (reduction.ts) DELIBERATELY stay shallow:
// they collapse only the empty / single-clause cases and preserve a
// multi-clause `and` whose member is a `match-all` verbatim, because
// the builder treats that as meaningful intermediate editing state
// (see reduction.ts's header + this package's CLAUDE.md "Reduction
// module"). That preservation is right for the DOC layer — the author
// may be mid-edit — but wrong for EMISSION: the wire should carry the
// author's EFFECTIVE filter, not the editing scaffolding. A `match-all`
// left inside an `and` emits a literal `match-all() and X` conjunct;
// CCHQ evaluates it as `X`, so it is not incorrect, but it is
// inaccurate config (the reported bug). A `match-none` inside an `and`
// absorbs the whole conjunction to "match nothing".
//
// `simplifyForEmission` is the recursive normalizer the wire-emission
// filter surfaces apply just before they serialize a Predicate:
//
//   - the search `_xpath_query` composer
//     (`lib/commcare/suite/case-search/xpathQuery.ts`),
//   - the case-list nodeset filter, suite XML
//     (`lib/commcare/suite/case-list/nodesetFilter.ts`),
//   - the case-list filter, HQ JSON
//     (`lib/commcare/hqJson/caseList.ts::projectCaseListFilter`).
//
// It applies the four boolean-algebra identities at EVERY depth — `and`
// drops `match-all` and absorbs `match-none`; `or` drops `match-none`
// and absorbs `match-all`; same-kind nesting flattens; `not` folds via
// the builder's `reduceNot` — and recurses through every nested
// Predicate slot, INCLUDING the ones reached through a ValueExpression
// operand (`count.where`, `if.cond`), so no nested conjunction can
// re-introduce the identity an outer pass removed. The mutual
// recursion mirrors `walk.ts` arm-for-arm; the exhaustiveness
// assertion at each `default:` forces a new union arm to be handled
// here rather than silently passing an un-simplified subtree to the
// wire.
//
// NEVER wire this into the construction builders or any doc-layer
// mutation: it destroys the editing-state fidelity `reduceAnd`
// deliberately preserves. It is an emission-only transform.

import {
	and,
	isMatchAll,
	isMatchNone,
	matchAll,
	matchNone,
	not,
	or,
} from "./builders";
import type { Predicate, ValueExpression } from "./types";

/**
 * Normalize a Predicate for wire emission: at every depth drop the
 * boolean identities (`and` drops match-all / absorbs match-none; `or`
 * is the dual), flatten same-kind nesting, and fold `not`. Returns
 * `match-all` when the whole predicate reduces to the always-true
 * identity (e.g. `and(match-all, match-all)`).
 *
 * Truth-value-preserving, NOT structure-preserving: a sentinel-free
 * but nested input is still rewritten (`and(and(a,b),c)` → `and(a,b,c)`;
 * `not(not(x))` → `x`). Don't use it to detect whether the author's
 * filter changed — only to produce the wire form. Filter callers
 * usually want `effectiveFilterForEmission` (below), which folds the
 * always-true result to `undefined`.
 */
export function simplifyForEmission(predicate: Predicate): Predicate {
	switch (predicate.kind) {
		case "match-all":
		case "match-none":
			return predicate;
		case "and":
			return simplifyConjunction(predicate.clauses);
		case "or":
			return simplifyDisjunction(predicate.clauses);
		case "not":
			// `not()` folds `not(match-all) → match-none`,
			// `not(match-none) → match-all`, and `not(not(x)) → x` via
			// `reduceNot`, so a simplified inner sentinel collapses the
			// negation rather than emitting `not(match-all())`.
			return not(simplifyForEmission(predicate.clause));
		case "exists":
		case "missing":
			return predicate.where === undefined
				? predicate
				: { ...predicate, where: simplifyForEmission(predicate.where) };
		case "when-input-present":
			return { ...predicate, clause: simplifyForEmission(predicate.clause) };
		case "eq":
		case "neq":
		case "gt":
		case "gte":
		case "lt":
		case "lte":
			return {
				...predicate,
				left: simplifyExpression(predicate.left),
				right: simplifyExpression(predicate.right),
			};
		case "in":
			// `values` are literals — no nested predicate / expression.
			return { ...predicate, left: simplifyExpression(predicate.left) };
		case "between":
			return {
				...predicate,
				left: simplifyExpression(predicate.left),
				...(predicate.lower !== undefined && {
					lower: simplifyExpression(predicate.lower),
				}),
				...(predicate.upper !== undefined && {
					upper: simplifyExpression(predicate.upper),
				}),
			};
		case "is-null":
		case "is-blank":
			return { ...predicate, left: simplifyExpression(predicate.left) };
		case "match":
			return { ...predicate, value: simplifyExpression(predicate.value) };
		case "within-distance":
			return { ...predicate, center: simplifyExpression(predicate.center) };
		case "multi-select-contains":
			// `property` is a PropertyRef and `values` are literals — no
			// nested predicate / expression to descend into.
			return predicate;
		default: {
			const _exhaustive: never = predicate;
			throw new Error(
				`simplifyForEmission: unhandled predicate kind ${String(_exhaustive)}`,
			);
		}
	}
}

/**
 * The "no effective filter" decision in ONE place: maps an authored
 * `caseListConfig.filter` slot (which may be absent) to the narrowing
 * predicate to emit, or `undefined` when nothing narrows — i.e. the
 * filter is absent OR reduces to the always-true identity (`match-all`,
 * top-level or e.g. `and(match-all, match-all)`).
 *
 * Every consumer of the filter slot goes through this one function —
 * the wire emitters (search `_xpath_query`, the case-list nodeset
 * filter on suite XML + HQ JSON), the preview query, the platform-shape
 * decision (`compileForPlatform`), and the searchable-surface validator
 * — so "does this filter narrow anything?" (test `=== undefined`) and
 * "what filter do we emit?" (use the returned predicate) can never
 * disagree. A SHALLOW `isMatchAll` check at a decision site while
 * emission simplifies deeply would let an `and(match-all, match-all)`
 * filter read as effective on one side and vanish on the other.
 *
 * Taking `Predicate | undefined` (not just `Predicate`) folds the
 * absent-filter case in too, so callers don't repeat the
 * `=== undefined ? undefined : …` guard. `match-none` is NOT folded —
 * it narrows to the empty set, a real query, so it rides through (the
 * caller emits `false()`).
 */
export function effectiveFilterForEmission(
	filter: Predicate | undefined,
): Predicate | undefined {
	if (filter === undefined) return undefined;
	const simplified = simplifyForEmission(filter);
	return isMatchAll(simplified) ? undefined : simplified;
}

/**
 * Simplify an `and` clause set: recurse into each clause, drop
 * `match-all` identities, short-circuit to `match-none` on the first
 * absorbing clause, and flatten nested `and`s. An empty survivor set
 * means every clause was the identity → `match-all`; a single survivor
 * unwraps; otherwise rebuild the n-ary `and`. A returned `and` is
 * guaranteed to carry only non-`and`, non-sentinel clauses, so a
 * parent's flatten never has to recurse.
 */
function simplifyConjunction(clauses: readonly Predicate[]): Predicate {
	const kept: Predicate[] = [];
	for (const clause of clauses) {
		const s = simplifyForEmission(clause);
		if (isMatchAll(s)) continue; // conjunction identity — drop
		if (isMatchNone(s)) return matchNone(); // absorbing element
		if (s.kind === "and") {
			kept.push(...s.clauses); // flatten
			continue;
		}
		kept.push(s);
	}
	if (kept.length === 0) return matchAll();
	if (kept.length === 1) return kept[0];
	return and(kept[0], kept[1], ...kept.slice(2));
}

/**
 * Simplify an `or` clause set — the dual of `simplifyConjunction`:
 * drop `match-none` identities, short-circuit to `match-all` on the
 * first absorbing clause, flatten nested `or`s. Empty survivors →
 * `match-none`; single unwraps; otherwise rebuild the n-ary `or`.
 */
function simplifyDisjunction(clauses: readonly Predicate[]): Predicate {
	const kept: Predicate[] = [];
	for (const clause of clauses) {
		const s = simplifyForEmission(clause);
		if (isMatchNone(s)) continue; // disjunction identity — drop
		if (isMatchAll(s)) return matchAll(); // absorbing element
		if (s.kind === "or") {
			kept.push(...s.clauses); // flatten
			continue;
		}
		kept.push(s);
	}
	if (kept.length === 0) return matchNone();
	if (kept.length === 1) return kept[0];
	return or(kept[0], kept[1], ...kept.slice(2));
}

/**
 * Descend into a ValueExpression to simplify the Predicate slots it
 * carries (`if.cond`, `count.where`) — the operand path through which
 * a redundant `match-all` could otherwise reach the wire inside a
 * comparison. Every other arm is rebuilt by recursing into its own
 * operands so the transform is total; sentinel-free expressions return
 * a structurally-equal node.
 */
function simplifyExpression(expr: ValueExpression): ValueExpression {
	switch (expr.kind) {
		case "term":
		case "today":
		case "now":
			return expr;
		case "date-add":
			return {
				...expr,
				date: simplifyExpression(expr.date),
				quantity: simplifyExpression(expr.quantity),
			};
		case "date-coerce":
		case "datetime-coerce":
		case "double":
		case "unwrap-list":
			return { ...expr, value: simplifyExpression(expr.value) };
		case "format-date":
			return { ...expr, date: simplifyExpression(expr.date) };
		case "arith":
			return {
				...expr,
				left: simplifyExpression(expr.left),
				right: simplifyExpression(expr.right),
			};
		case "concat":
			// `.map` preserves length, so the result keeps the schema's
			// non-empty-tuple shape — assert it back since `map` widens to
			// a plain array.
			return {
				...expr,
				parts: expr.parts.map(simplifyExpression) as typeof expr.parts,
			};
		case "coalesce":
			return {
				...expr,
				values: expr.values.map(simplifyExpression) as typeof expr.values,
			};
		case "if":
			return {
				...expr,
				cond: simplifyForEmission(expr.cond),
				// biome-ignore lint/suspicious/noThenProperty: AST shape mirrors `ifSchema`; `then` holds a ValueExpression object, never a callable (same contract as the `ifExpr` builder in builders.ts).
				then: simplifyExpression(expr.then),
				else: simplifyExpression(expr.else),
			};
		case "switch":
			return {
				...expr,
				on: simplifyExpression(expr.on),
				cases: expr.cases.map((c) => ({
					...c,
					// biome-ignore lint/suspicious/noThenProperty: `SwitchCase.then` is a ValueExpression object per `switchCaseSchema`, never a callable.
					then: simplifyExpression(c.then),
				})) as typeof expr.cases,
				fallback: simplifyExpression(expr.fallback),
			};
		case "count":
			return expr.where === undefined
				? expr
				: { ...expr, where: simplifyForEmission(expr.where) };
		default: {
			const _exhaustive: never = expr;
			throw new Error(
				`simplifyForEmission: unhandled value expression kind ${String(_exhaustive)}`,
			);
		}
	}
}
