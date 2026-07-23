// lib/domain/predicate/normalizeRelationReads.ts
//
// CSQL grammar adaptation for property reads through a relation. Every target
// first runs `normalizeRelationEvaluationScopes`, which gives a relational
// scalar leaf one explicit related-row meaning and rejects mixed row scopes.
// CSQL then runs this narrower pass because its native grammar has additional
// operand-shape constraints: any supported `prop(via)` that remains after
// target-independent normalization becomes an `exists(via, where: ...)` query
// function whose inner property is scoped to the relation destination.
//
// CCHQ's parser does recognise a `<rel>/<prop> = <value>` shape on the
// comparison's left side via `is_ancestor_comparison` at
// `commcare-hq/corehq/apps/case_search/xpath_functions/ancestor_functions.py::is_ancestor_comparison`,
// but Nova does not emit that shape — staying on the single canonical
// envelope form keeps the wire surface consistent across operators
// and avoids per-operator branching on "does this operator's slot
// admit the slash-path form?".
//
// Two entry shapes carry property-via references reaching the
// segment emitter:
//
//   - Direct `PropertyRef` slot: `match.property`,
//     `multi-select-contains.property`, `within-distance.property`.
//   - `ValueExpression`-wrapped as `term(prop(via))`, either directly
//     or below a CSQL-native value function, in operand slots:
//     `compare.{left,right}`, `in.left`,
//     `between.{left,lower,upper}`, `is-null.left`, `is-blank.left`,
//     `match.value`, and `within-distance.center`.
//
// The walker handles both shapes uniformly via `normalizePredicate`,
// which dispatches per operator arm and rebuilds the predicate when
// a via lifts. The walk recurses into structural predicate-bearing
// slots (`and.clauses`, `or.clauses`, `not.clause`,
// `when-input-present.clause`, `exists.where`, `missing.where`) so
// vias nested inside logical operators surface. Within a
// `ValueExpression`, the walk follows only the CSQL-native function
// arms. Non-native expression roots (`arith`, `if`, `concat`, etc.)
// remain scalar expressions. Their term compiler/emitter retains `via`, so a
// scalar such as `arith(prop(via), ...)` keeps the existing one-value behavior.
//
// Idempotence: the rewrite is structurally cycle-free. Each call to
// `normalizePredicate` strips at most one native-emitted via per
// recursive invocation (the new envelope's inner `where` contains
// the property with that via gone), and the recursive descent reaches
// the inner `where` and re-runs. A second top-level normalization
// over the result produces the same output — no native-emitted vias
// remain to lift.
//
// Non-grammar value expressions (`if`, `switch`, `arith`, `concat`,
// `coalesce`, `format-date`, non-LHS `count`, ancestor/any-relation
// `count`) do NOT lift here. The CSQL emitter inlines them as
// runtime on-device XPath fragments inside the outer `concat(...)`
// wrapper, matching the canonical CCHQ pattern documented in
// `commcare-hq/docs/case_search_query_language.rst`:
//
//   concat(
//     'subcase-exists("parent", @case_type = "service" and …, "',
//     instance('casedb')/casedb/case[@case_type='commcare-user']…,
//     '"))'
//   )
//
// The `instance(...)` evaluates on-device at concat-time and its
// string result substitutes inline into the CSQL fragment. CCHQ's
// `RemoteQuerySessionManager.initUserAnswers` /
// `getUserQueryValues` only thread `<prompt>` values through the
// `search-input:results` instance — synthetic search-input keys
// emitted on sibling `<data>` slots never reach that instance, so
// inlining is the only wire-correct shape for runtime-resolved
// expressions reachable inside `_xpath_query`.
//
// `is-null` and `is-blank` rewrite to the same wire form on CSQL
// (`<term> = ''`); the rewrite happens at the emitter, not here, so
// the via-lift pass leaves both intact.

import type { CaseType } from "../blueprint";
import { relationDestinationCaseType } from "./rewrite";
import { checkRelationPath } from "./typeChecker";
import type {
	ComparisonKind,
	Predicate,
	PropertyRef,
	RelationPath,
	ValueExpression,
} from "./types";

export interface RelationReadNormalizationContext {
	/**
	 * Optional schema context used to resolve unqualified relation paths. Wire
	 * emitters do not need it because case-type qualifiers are not serialized;
	 * typed runtimes pass it so the inner self-scoped PropertyRef names the
	 * destination case type even when the authored path omitted a hint.
	 */
	readonly caseTypes?: ReadonlyArray<CaseType>;
	/** CSQL uses `throw`; on-device/SQL preserve shapes their compilers handle. */
	readonly unsupportedPropertyOperands?: "preserve" | "throw";
}

/**
 * Top-level entry point. Runs the property-via lift and returns the
 * rewritten AST. `when-input-present` predicates pass through
 * unchanged at this layer; the emitter handles them via recursive
 * CSQL emission and the canonical
 * `if(count(<trigger>), <inner-csql>, 'match-all()')` wrapper.
 *
 * The input predicate is never mutated. Returned subtrees are either
 * fresh objects (every arm that rebuilds, every lift site) or shared
 * with the input by reference (the leaf arms for terms, sentinels,
 * and grammar-only ValueExpressions where no descendant lifts).
 * Consumers may compose the result with other AST work without
 * disturbing the input.
 *
 * Exported also as `liftPropertyVias` so the case-list validator can
 * walk the post-lift shape — the AST that actually reaches the CSQL
 * emitter — when checking structural CSQL contracts (e.g. CCHQ's
 * `_validate_ancestor_exists_filter` rejection of subcase-relation
 * walks nested inside an ancestor-relation walk).
 */
export function normalizeRelationPropertyReads(
	predicate: Predicate,
	context: RelationReadNormalizationContext = {},
): Predicate {
	return normalizePredicate(
		normalizeRelationPredicateSubjects(predicate, context),
		context,
	);
}

/**
 * Lower the three predicate operators whose dedicated `property` slot is the
 * subject of one test (`match`, `multi-select-contains`, and
 * `within-distance`). A non-self subject means "some related case satisfies
 * this whole operator", so every runtime consumes the same explicit
 * `exists(via, where: operator(prop(self), ...))` shape.
 *
 * This helper predates and is intentionally narrower than the shared
 * `normalizeRelationEvaluationScopes` pass. Public target entry points use the
 * shared pass; this function remains as a CSQL grammar-adapter building block
 * and for callers that need to normalize only these dedicated subject slots.
 * Structural predicate children are walked here. Predicate children embedded
 * in a ValueExpression (`if.cond`, `count.where`) re-enter each target's public
 * predicate entry point when compiled.
 */
export function normalizeRelationPredicateSubjects(
	predicate: Predicate,
	context: RelationReadNormalizationContext = {},
): Predicate {
	switch (predicate.kind) {
		case "match": {
			const lifted = readViaFromPropertyRef(predicate.property, context);
			if (lifted === undefined) return predicate;
			return wrapInExists(lifted.via, {
				...predicate,
				property: lifted.propWithoutVia,
			});
		}
		case "multi-select-contains": {
			const lifted = readViaFromPropertyRef(predicate.property, context);
			if (lifted === undefined) return predicate;
			return wrapInExists(lifted.via, {
				...predicate,
				property: lifted.propWithoutVia,
			});
		}
		case "within-distance": {
			const lifted = readViaFromPropertyRef(predicate.property, context);
			if (lifted === undefined) return predicate;
			return wrapInExists(lifted.via, {
				...predicate,
				property: lifted.propWithoutVia,
			});
		}
		case "and":
		case "or": {
			const clauses = predicate.clauses.map((clause) =>
				normalizeRelationPredicateSubjects(clause, context),
			) as [Predicate, ...Predicate[]];
			return clauses.every(
				(clause, index) => clause === predicate.clauses[index],
			)
				? predicate
				: { ...predicate, clauses };
		}
		case "not": {
			const clause = normalizeRelationPredicateSubjects(
				predicate.clause,
				context,
			);
			return clause === predicate.clause ? predicate : { ...predicate, clause };
		}
		case "when-input-present": {
			const clause = normalizeRelationPredicateSubjects(
				predicate.clause,
				context,
			);
			return clause === predicate.clause ? predicate : { ...predicate, clause };
		}
		case "exists":
		case "missing": {
			if (predicate.where === undefined) return predicate;
			const where = normalizeRelationPredicateSubjects(
				predicate.where,
				context,
			);
			return where === predicate.where ? predicate : { ...predicate, where };
		}
		case "match-all":
		case "match-none":
		case "eq":
		case "neq":
		case "gt":
		case "gte":
		case "lt":
		case "lte":
		case "in":
		case "between":
		case "is-null":
		case "is-blank":
			return predicate;
		default: {
			const _exhaustive: never = predicate;
			throw new Error(
				`normalizeRelationPredicateSubjects: hit an unhandled predicate kind '${String(_exhaustive)}'. Decide whether a new operator has a dedicated property-subject slot before extending this dispatch.`,
			);
		}
	}
}

/**
 * Per-operator dispatcher for the via-lift walk. Each operator arm
 * either (a) detects a via on its property slot and returns the
 * `exists`-wrapped rewrite, (b) recurses into structural
 * predicate-bearing children and rebuilds, or (c) passes through
 * unchanged (sentinels).
 */
function normalizePredicate(
	p: Predicate,
	context: RelationReadNormalizationContext,
): Predicate {
	switch (p.kind) {
		case "match-all":
		case "match-none":
			return p;
		case "eq":
		case "neq":
		case "gt":
		case "gte":
		case "lt":
		case "lte":
			return liftComparisonVias(p, context);
		case "in":
			return liftInVias(p, context);
		case "between":
			return liftBetweenVias(p, context);
		case "is-null":
		case "is-blank":
			return liftAbsenceVias(p, context);
		case "match":
			return liftMatchVias(p, context);
		case "multi-select-contains":
			return liftMultiSelectVias(p, context);
		case "within-distance":
			return liftWithinDistanceVias(p, context);
		case "and":
			return {
				kind: "and",
				clauses: p.clauses.map((c) => normalizePredicate(c, context)) as [
					Predicate,
					...Predicate[],
				],
			};
		case "or":
			return {
				kind: "or",
				clauses: p.clauses.map((c) => normalizePredicate(c, context)) as [
					Predicate,
					...Predicate[],
				],
			};
		case "not":
			return { kind: "not", clause: normalizePredicate(p.clause, context) };
		case "when-input-present":
			return {
				kind: "when-input-present",
				input: p.input,
				clause: normalizePredicate(p.clause, context),
			};
		case "exists":
		case "missing": {
			// The envelope's own `via` stays as-is; only the inner
			// `where` walks. An author-written envelope wrapping a
			// predicate whose properties read across yet another
			// relation produces nested envelopes after the lift —
			// each level's via emits as its own `ancestor-exists` /
			// `subcase-exists` call at the segment emitter, which is
			// the canonical CCHQ pattern for chained relational
			// reads.
			if (p.where === undefined) return p;
			return {
				kind: p.kind,
				via: p.via,
				where: normalizePredicate(p.where, context),
			};
		}
		default: {
			const _exhaustive: never = p;
			throw new Error(
				`normalizeRelationPropertyReads: hit an unhandled predicate kind '${String(_exhaustive)}'. Extend the shared relation-read normalization before adding a new Predicate arm.`,
			);
		}
	}
}

/**
 * Lift property vias inside a comparison's operand pair. The two
 * operand slots are symmetric `ValueExpression` slots; either side
 * may carry a direct `term(prop(via))`, a native value function with
 * a descendant property-via, or a `count(via, where=...)` whose inner
 * `where` clause references property-vias. The rewrite picks LHS first
 * when both carry a via — recursion into the rewritten envelope's
 * inner `where` reaches the RHS via on the next pass.
 *
 * Asymmetric comparison operators (`gt` / `gte` / `lt` / `lte`)
 * swap when the via lifts from the RHS so the semantic comparison
 * direction is preserved — `gt(a, prop(via))` becomes
 * `exists(via, where: lt(prop, a))`, not the meaning-flipped
 * `exists(via, where: gt(prop, a))`. `eq` / `neq` are symmetric and
 * the operator passes through unchanged.
 *
 * After the term-arm via checks fail, the walker descends into any
 * `count.where` clauses sitting in operand position. `subcase`-
 * direction `count` survives at the CSQL emitter in comparison-LHS
 * position as native `subcase-count(...)`, and its `where` argument
 * runs through the CSQL predicate emitter at emission time — so a
 * `prop(via)` inside the `where` would otherwise drop its relation
 * walk at the segment emitter.
 */
function liftComparisonVias(
	p: Extract<Predicate, { kind: ComparisonKind }>,
	context: RelationReadNormalizationContext,
): Predicate {
	const barrier = propertyOperandBarrier([p.left, p.right]);
	if (barrier !== undefined) {
		return handlePropertyOperandBarrier(p, p.kind, barrier, context);
	}
	const leftViaProp = readDirectViaPropFromValueExpression(p.left, context);
	if (leftViaProp !== undefined) {
		const { via, propWithoutVia } = leftViaProp;
		// Recurse so a via on the RHS (or a second via on the inner
		// `where`) lifts on the next pass.
		const inner = normalizePredicate(
			{
				kind: p.kind,
				left: { kind: "term", term: propWithoutVia },
				right: p.right,
			},
			context,
		);
		return wrapInExists(via, inner);
	}
	const rightViaProp = readDirectViaPropFromValueExpression(p.right, context);
	if (rightViaProp !== undefined) {
		const { via, propWithoutVia } = rightViaProp;
		if (p.kind === "eq" || p.kind === "neq") {
			// Symmetric operators preserve operand order — the inner
			// comparison keeps `<original-left> <op> <prop>`, matching
			// the authored shape. Both CSQL and on-device evaluators
			// treat the two sides equivalently for symmetric ops.
			const inner = normalizePredicate(
				{
					kind: p.kind,
					left: p.left,
					right: { kind: "term", term: propWithoutVia },
				},
				context,
			);
			return wrapInExists(via, inner);
		}
		// Asymmetric operators swap when the property moves from
		// the RHS to the inner LHS so the comparison direction
		// stays intact — `gt(a, prop(via))` reads "a > <related
		// prop>", which is equivalent to "<related prop> < a" —
		// i.e. `lt(prop, a)` inside the envelope.
		const innerKind = ASYMMETRIC_COMPARISON_SWAP[p.kind];
		const inner = normalizePredicate(
			{
				kind: innerKind,
				left: { kind: "term", term: propWithoutVia },
				right: p.left,
			},
			context,
		);
		return wrapInExists(via, inner);
	}
	// A property can also sit below a CSQL-native value function
	// (`date(prop(via))`, `date-add(prop(via), ...)`, etc.). The
	// function call itself stays in the same operand slot; only the
	// descendant property's relation walk moves to the envelope.
	// Unlike the direct-RHS case above, no operator swap is needed:
	// the wrapped expression remains on the RHS.
	const liftedLeft = liftFirstViaInCsqlValueExpression(p.left, context);
	if (liftedLeft.lifted) {
		const inner = normalizePredicate(
			{
				kind: p.kind,
				left: liftedLeft.expression,
				right: p.right,
			},
			context,
		);
		return wrapInExists(liftedLeft.via, inner);
	}
	const liftedRight = liftFirstViaInCsqlValueExpression(p.right, context);
	if (liftedRight.lifted) {
		const inner = normalizePredicate(
			{
				kind: p.kind,
				left: liftedLeft.expression,
				right: liftedRight.expression,
			},
			context,
		);
		return wrapInExists(liftedRight.via, inner);
	}

	// Walk into `count.where` clauses on either operand. The CSQL
	// emitter splices the `where` argument's segment list into the
	// surrounding `subcase-count(...)` call, so a via inside the
	// `where` reaches the property-ref emitter directly; the pre-pass
	// needs to lift those vias before emission runs.
	const countWalkedLeft = liftViaInCountWhere(liftedLeft.expression, context);
	const countWalkedRight = liftViaInCountWhere(liftedRight.expression, context);
	if (countWalkedLeft !== p.left || countWalkedRight !== p.right) {
		return {
			kind: p.kind,
			left: countWalkedLeft,
			right: countWalkedRight,
		};
	}
	return p;
}

/**
 * Walk into the `where` clause of a `count` value expression and
 * run the via-lift recursively. The `count` arm survives at the
 * CSQL emitter only in comparison-LHS position with `subcase`
 * direction (CCHQ's `_is_subcase_count` recogniser); other `count`
 * shapes inline as on-device XPath fragments, which handle
 * property-vias correctly at the term layer. Walking unconditionally
 * is cheap and keeps the LHS-subcase-count case correct without a
 * lookahead.
 */
function liftViaInCountWhere(
	expr: ValueExpression,
	context: RelationReadNormalizationContext,
): ValueExpression {
	if (expr.kind !== "count" || expr.where === undefined) return expr;
	const liftedWhere = normalizePredicate(expr.where, context);
	if (liftedWhere === expr.where) return expr;
	return { kind: "count", via: expr.via, where: liftedWhere };
}

/**
 * Operator swap table for asymmetric comparisons on the RHS-via
 * lift. The swap preserves the semantic direction of the
 * comparison when the property moves from the RHS to the inner
 * envelope's LHS. Symmetric operators (`eq` / `neq`) are not in
 * this table — the symmetric branch in `liftComparisonVias` is
 * the one place that handles them, preserving operand order.
 */
type AsymmetricComparison = Exclude<ComparisonKind, "eq" | "neq">;
const ASYMMETRIC_COMPARISON_SWAP: Record<
	AsymmetricComparison,
	AsymmetricComparison
> = {
	gt: "lt",
	gte: "lte",
	lt: "gt",
	lte: "gte",
};

/**
 * Lift property vias on `in.left`. Only `left` carries a via — the
 * `values` slot is a literal tuple per `inSchema.values` in
 * `lib/domain/predicate/types.ts`, so no via can hide there.
 */
function liftInVias(
	p: Extract<Predicate, { kind: "in" }>,
	context: RelationReadNormalizationContext,
): Predicate {
	const liftedLeft = liftFirstViaInCsqlValueExpression(p.left, context);
	if (!liftedLeft.lifted) return p;
	const inner = normalizePredicate(
		{
			kind: "in",
			left: liftedLeft.expression,
			values: p.values,
		},
		context,
	);
	return wrapInExists(liftedLeft.via, inner);
}

/**
 * Lift property vias inside a `between`. Nova defines a generic
 * `between(prop(via), lower, upper)` as two independently quantified
 * comparisons. Different related rows may therefore satisfy the two bounds.
 * CSQL preserves that by emitting a separate relation envelope per bound.
 * Callers that require one related row to satisfy both bounds author that
 * explicitly as `exists(via, where: between(prop(self), ...))`.
 *
 * The schema rejects the both-bounds-absent shape; the rebuild
 * preserves the conditional-spread shape so the absent-key contract
 * stays intact through the lift.
 */
function liftBetweenVias(
	p: Extract<Predicate, { kind: "between" }>,
	context: RelationReadNormalizationContext,
): Predicate {
	const barrier = propertyOperandBarrier([
		p.left,
		...(p.lower === undefined ? [] : [p.lower]),
		...(p.upper === undefined ? [] : [p.upper]),
	]);
	if (barrier !== undefined) {
		return handlePropertyOperandBarrier(p, "between", barrier, context);
	}
	const leftViaProp = readDirectViaPropFromValueExpression(p.left, context);
	if (leftViaProp !== undefined) {
		const { via, propWithoutVia } = leftViaProp;
		const boundedComparisons: Predicate[] = [];
		if (p.lower !== undefined) {
			boundedComparisons.push(
				wrapInExists(
					via,
					normalizePredicate(
						{
							kind: p.lowerInclusive ? "gte" : "gt",
							left: { kind: "term", term: propWithoutVia },
							right: p.lower,
						},
						context,
					),
				),
			);
		}
		if (p.upper !== undefined) {
			boundedComparisons.push(
				wrapInExists(
					via,
					normalizePredicate(
						{
							kind: p.upperInclusive ? "lte" : "lt",
							left: { kind: "term", term: propWithoutVia },
							right: p.upper,
						},
						context,
					),
				),
			);
		}
		if (boundedComparisons.length === 1) return boundedComparisons[0];
		if (boundedComparisons.length === 2) {
			return {
				kind: "and",
				clauses: [boundedComparisons[0], boundedComparisons[1]],
			};
		}
		throw new Error(
			"normalizeRelationPropertyReads: a between predicate reached relation lowering without either bound. The schema should have rejected this shape.",
		);
	}
	if (p.lower !== undefined) {
		const lowerViaProp = readDirectViaPropFromValueExpression(p.lower, context);
		if (lowerViaProp !== undefined) {
			// A via on a `between` bound rewrites by lifting the
			// bound's via to the envelope. `between(left, lower=L,
			// ...)` semantics is `left >= L` (inclusive) /
			// `left > L` (exclusive); from the envelope's
			// destination scope, the prop is L's value and the
			// condition reads as `prop <= left` /
			// `prop < left` respectively — i.e. the comparison
			// flips direction when the bound moves to the inner
			// LHS. The shape is unusual (typical bounds are
			// literals or runtime refs) but the structural
			// correctness rule applies uniformly.
			const { via, propWithoutVia } = lowerViaProp;
			const op: ComparisonKind = p.lowerInclusive ? "lte" : "lt";
			const inner = normalizePredicate(
				{
					kind: op,
					left: { kind: "term", term: propWithoutVia },
					right: p.left,
				},
				context,
			);
			// `lower`-only bound after extraction: if `upper` is
			// also absent, the rewritten inner replaces `between`
			// entirely; otherwise the AND-composition preserves the
			// upper-bound side. `between` with both bounds absent
			// is structurally invalid per `betweenSchema`'s
			// `.refine`, so the both-absent branch is unreachable
			// for a parsed AST.
			if (p.upper === undefined) {
				return wrapInExists(via, inner);
			}
			const others: Predicate = normalizePredicate(
				{
					kind: "between",
					left: p.left,
					upper: p.upper,
					lowerInclusive: p.lowerInclusive,
					upperInclusive: p.upperInclusive,
				},
				context,
			);
			return {
				kind: "and",
				clauses: [wrapInExists(via, inner), others],
			};
		}
	}
	if (p.upper !== undefined) {
		const upperViaProp = readDirectViaPropFromValueExpression(p.upper, context);
		if (upperViaProp !== undefined) {
			// Symmetric to the `lower`-bound rewrite: original
			// `left <= U` becomes `U_prop >= left` inside the
			// envelope (the direction flips when the bound moves
			// to the inner LHS).
			const { via, propWithoutVia } = upperViaProp;
			const op: ComparisonKind = p.upperInclusive ? "gte" : "gt";
			const inner = normalizePredicate(
				{
					kind: op,
					left: { kind: "term", term: propWithoutVia },
					right: p.left,
				},
				context,
			);
			// `upper`-only branch: `lower` was either absent or
			// already via-free (the LHS-via lift above handles the
			// LHS case). Both-bounds-absent is unreachable per the
			// schema refine.
			if (p.lower === undefined) {
				return wrapInExists(via, inner);
			}
			const lowerOnly: Predicate = normalizePredicate(
				{
					kind: "between",
					left: p.left,
					lower: p.lower,
					lowerInclusive: p.lowerInclusive,
					upperInclusive: p.upperInclusive,
				},
				context,
			);
			return {
				kind: "and",
				clauses: [wrapInExists(via, inner), lowerOnly],
			};
		}
	}

	// Direct term-arm bounds above need the comparison-direction
	// rewrites because their property moves to an inner LHS. A via
	// nested below a native value function stays in its authored slot,
	// so the whole `between` can be wrapped without changing either
	// bound operator.
	const liftedLeft = liftFirstViaInCsqlValueExpression(p.left, context);
	if (liftedLeft.lifted) {
		const inner = normalizePredicate(
			{
				kind: "between",
				left: liftedLeft.expression,
				...(p.lower !== undefined ? { lower: p.lower } : {}),
				...(p.upper !== undefined ? { upper: p.upper } : {}),
				lowerInclusive: p.lowerInclusive,
				upperInclusive: p.upperInclusive,
			},
			context,
		);
		return wrapInExists(liftedLeft.via, inner);
	}

	const liftedLower =
		p.lower === undefined
			? undefined
			: liftFirstViaInCsqlValueExpression(p.lower, context);
	if (liftedLower?.lifted) {
		const inner = normalizePredicate(
			{
				kind: "between",
				left: liftedLeft.expression,
				lower: liftedLower.expression,
				...(p.upper !== undefined ? { upper: p.upper } : {}),
				lowerInclusive: p.lowerInclusive,
				upperInclusive: p.upperInclusive,
			},
			context,
		);
		return wrapInExists(liftedLower.via, inner);
	}

	const liftedUpper =
		p.upper === undefined
			? undefined
			: liftFirstViaInCsqlValueExpression(p.upper, context);
	if (liftedUpper?.lifted) {
		const inner = normalizePredicate(
			{
				kind: "between",
				left: liftedLeft.expression,
				...(liftedLower !== undefined ? { lower: liftedLower.expression } : {}),
				upper: liftedUpper.expression,
				lowerInclusive: p.lowerInclusive,
				upperInclusive: p.upperInclusive,
			},
			context,
		);
		return wrapInExists(liftedUpper.via, inner);
	}
	return p;
}

/**
 * Lift property vias on `is-null.left` / `is-blank.left`. Single
 * operand; the rewrite mirrors the LHS lift on comparisons.
 */
function liftAbsenceVias(
	p: Extract<Predicate, { kind: "is-null" | "is-blank" }>,
	context: RelationReadNormalizationContext,
): Predicate {
	const liftedLeft = liftFirstViaInCsqlValueExpression(p.left, context);
	if (!liftedLeft.lifted) return p;
	const inner = normalizePredicate(
		{
			kind: p.kind,
			left: liftedLeft.expression,
		},
		context,
	);
	return wrapInExists(liftedLeft.via, inner);
}

/**
 * Lift the via on `match.property`. `match.property` is a direct
 * `PropertyRef` slot — the type checker constrains it to a
 * `propertyRefSchema` per `matchSchema` in
 * `lib/domain/predicate/types.ts`. The lift envelope carries the
 * relation walk; the inner `match` retains the same mode and value.
 *
 * `match.value` is a term-arm ValueExpression at emission time. A
 * property-via in that term needs the same envelope treatment; the
 * native CSQL term emitter prints only the property name and cannot
 * carry a relation path inline.
 */
function liftMatchVias(
	p: Extract<Predicate, { kind: "match" }>,
	context: RelationReadNormalizationContext,
): Predicate {
	const propVia = readViaFromPropertyRef(p.property, context);
	if (propVia !== undefined) {
		const { via, propWithoutVia } = propVia;
		const inner = normalizePredicate(
			{
				kind: "match",
				property: propWithoutVia,
				value: p.value,
				mode: p.mode,
			},
			context,
		);
		return wrapInExists(via, inner);
	}

	const liftedValue = liftFirstViaInCsqlValueExpression(p.value, context);
	if (!liftedValue.lifted) return p;
	const inner = normalizePredicate(
		{
			kind: "match",
			property: p.property,
			value: liftedValue.expression,
			mode: p.mode,
		},
		context,
	);
	return wrapInExists(liftedValue.via, inner);
}

/**
 * Lift the via on `multi-select-contains.property`. Same shape as
 * `liftMatchVias`: the direct `PropertyRef` slot moves to the
 * envelope, the inner operator retains its quantifier + values.
 */
function liftMultiSelectVias(
	p: Extract<Predicate, { kind: "multi-select-contains" }>,
	context: RelationReadNormalizationContext,
): Predicate {
	const propVia = readViaFromPropertyRef(p.property, context);
	if (propVia === undefined) return p;
	const { via, propWithoutVia } = propVia;
	const inner = normalizePredicate(
		{
			kind: "multi-select-contains",
			property: propWithoutVia,
			values: p.values,
			quantifier: p.quantifier,
		},
		context,
	);
	return wrapInExists(via, inner);
}

/**
 * Lift vias from both `within-distance.property` and its `center`
 * ValueExpression. CCHQ's native function accepts only a property
 * name plus a value; it has no inline syntax for a relational center
 * property, so the relation walk must live on an enclosing query-
 * function envelope rather than being silently erased by the term
 * emitter.
 */
function liftWithinDistanceVias(
	p: Extract<Predicate, { kind: "within-distance" }>,
	context: RelationReadNormalizationContext,
): Predicate {
	const propVia = readViaFromPropertyRef(p.property, context);
	if (propVia !== undefined) {
		const { via, propWithoutVia } = propVia;
		const inner = normalizePredicate(
			{
				kind: "within-distance",
				property: propWithoutVia,
				center: p.center,
				distance: p.distance,
				unit: p.unit,
			},
			context,
		);
		return wrapInExists(via, inner);
	}

	const liftedCenter = liftFirstViaInCsqlValueExpression(p.center, context);
	if (!liftedCenter.lifted) return p;
	const inner = normalizePredicate(
		{
			kind: "within-distance",
			property: p.property,
			center: liftedCenter.expression,
			distance: p.distance,
			unit: p.unit,
		},
		context,
	);
	return wrapInExists(liftedCenter.via, inner);
}

/**
 * Wrap an inner predicate in the per-direction `exists` envelope
 * for the given via. Direction dispatch:
 *
 *   - `ancestor` / `subcase`: emit a single `exists` with the via
 *     attached and the inner predicate as the `where` filter.
 *   - `any-relation`: expand to an OR of the two direction-specific
 *     envelopes, mirroring the on-device emitter's any-relation
 *     expansion at `caseListFilterEmitter.ts::emitExistsOrMissing`.
 *     The result is `or(exists(ancestor), exists(subcase))` so the
 *     predicate matches when the related case exists in either
 *     direction.
 *   - `self`: unreachable from `readViaFromPropertyRef` / the value-
 *     expression lift helper (both filter `self` out at the read
 *     site); the throw is a structural defense.
 */
function wrapInExists(via: RelationPath, inner: Predicate): Predicate {
	switch (via.kind) {
		case "ancestor":
		case "subcase":
			return { kind: "exists", via, where: inner };
		case "any-relation": {
			const ancestor: RelationPath = {
				kind: "ancestor",
				via: [
					via.ofCaseType === undefined
						? { identifier: via.identifier }
						: {
								identifier: via.identifier,
								throughCaseType: via.ofCaseType,
							},
				],
			};
			const subcase: RelationPath = {
				kind: "subcase",
				identifier: via.identifier,
				...(via.ofCaseType === undefined ? {} : { ofCaseType: via.ofCaseType }),
			};
			return {
				kind: "or",
				clauses: [
					{ kind: "exists", via: ancestor, where: inner },
					{ kind: "exists", via: subcase, where: inner },
				],
			};
		}
		case "self":
			throw new Error(
				"normalizeRelationPropertyReads: a self relation reached the exists wrapper even though self carries no traversal.",
			);
		default: {
			const _exhaustive: never = via;
			throw new Error(
				`normalizeRelationPropertyReads: hit an unhandled RelationPath kind '${String(_exhaustive)}'.`,
			);
		}
	}
}

/**
 * A relational property can be lifted only when every predicate-native
 * property operand is evaluated in the same case-row scope. Moving a mixed
 * self/related or two-relation comparison inside one exists envelope would
 * silently re-anchor the other operand. The validator reports the friendly
 * `multiple-property-scopes` finding; this throw protects compiler bypasses.
 */
type PropertyOperandBarrier =
	| "multiple-property-scopes"
	| "case-property-on-value-side";

function propertyOperandBarrier(
	operands: ReadonlyArray<ValueExpression>,
): PropertyOperandBarrier | undefined {
	const properties = operands.flatMap(nativePropertyRefs);
	if (!properties.some(hasNonSelfVia)) return undefined;
	const scopes = new Set(properties.map(propertyScopeKey));
	if (scopes.size > 1) return "multiple-property-scopes";
	return properties.length > 1 ? "case-property-on-value-side" : undefined;
}

function handlePropertyOperandBarrier<T extends Predicate>(
	predicate: T,
	operator: ComparisonKind | "between",
	reason: PropertyOperandBarrier,
	context: RelationReadNormalizationContext,
): T {
	if (context.unsupportedPropertyOperands !== "throw") return predicate;
	const detail =
		reason === "multiple-property-scopes"
			? "compares properties from different case-row scopes"
			: "compares two related case properties";
	throw new Error(
		`normalizeRelationPropertyReads [${reason}]: '${operator}' ${detail}. CSQL accepts a related case property only against a fixed, entered, or session value; the validator should reject this predicate before CSQL compilation.`,
	);
}

function hasNonSelfVia(property: PropertyRef): boolean {
	return property.via !== undefined && property.via.kind !== "self";
}

function propertyScopeKey(property: PropertyRef): string {
	const via = property.via;
	return via === undefined || via.kind === "self"
		? `self:${property.caseType}`
		: `relation:${property.caseType}:${JSON.stringify(via)}`;
}

/** PropertyRefs reachable through predicate-native ValueExpression arms. */
function nativePropertyRefs(expression: ValueExpression): PropertyRef[] {
	switch (expression.kind) {
		case "term":
			return expression.term.kind === "prop" ? [expression.term] : [];
		case "date-coerce":
		case "datetime-coerce":
		case "double":
		case "unwrap-list":
			return nativePropertyRefs(expression.value);
		case "date-add":
			return [
				...nativePropertyRefs(expression.date),
				...nativePropertyRefs(expression.quantity),
			];
		case "today":
		case "now":
		case "id-of":
		case "acting-user":
		case "unowned":
		case "table-lookup":
		case "arith":
		case "concat":
		case "coalesce":
		case "if":
		case "switch":
		case "count":
		case "format-date":
			return [];
		default: {
			const _exhaustive: never = expression;
			throw new Error(
				`normalizeRelationPropertyReads: hit an unhandled ValueExpression kind '${String(_exhaustive)}' while checking property scopes.`,
			);
		}
	}
}

/**
 * Read the lift descriptor from a property reference. Returns
 * `undefined` for `self` / absent-via property refs (nothing to
 * lift); otherwise returns the via to attach to the envelope and a
 * fresh `PropertyRef` with the via slot stripped.
 *
 * The returned `propWithoutVia` carries the same `caseType` slot as
 * the input — no downstream consumer of the lifted AST reads it
 * (the CSQL emitter resolves property names against the envelope's
 * via at runtime; the type checker has already run on the authored
 * AST upstream of the emitter).
 */
function readViaFromPropertyRef(
	prop: PropertyRef,
	context: RelationReadNormalizationContext,
): { via: RelationPath; propWithoutVia: PropertyRef } | undefined {
	const via = prop.via;
	if (via === undefined || via.kind === "self") return undefined;
	const propWithoutVia: PropertyRef = {
		kind: "prop",
		caseType: destinationCaseType(prop, via, context),
		property: prop.property,
	};
	return { via, propWithoutVia };
}

/** Resolve the inner self-scope after removing a PropertyRef's relation path. */
function destinationCaseType(
	prop: PropertyRef,
	via: Exclude<RelationPath, { kind: "self" }>,
	context: RelationReadNormalizationContext,
): string {
	const hinted = relationDestinationCaseType(via, prop.caseType);
	if (hinted !== undefined) return hinted;
	if (context.caseTypes === undefined) return prop.caseType;

	const errors: Parameters<typeof checkRelationPath>[3] = [];
	const resolved = checkRelationPath(
		via,
		prop.caseType,
		{ caseTypes: [...context.caseTypes], knownInputs: [] },
		errors,
		["normalize-relation-read", "via"],
	);
	// The authored document is validated before compilation. Keeping the origin
	// on a bypassed invalid path lets the downstream type compiler surface its
	// existing precise invariant instead of inventing a fallback destination.
	return resolved ?? prop.caseType;
}

/** Resolve the destination scope for a PropertyRef without rewriting it. */
export function relationPropertyDestinationCaseType(
	property: PropertyRef,
	context: RelationReadNormalizationContext = {},
): string {
	const via = property.via;
	if (via === undefined || via.kind === "self") return property.caseType;
	return destinationCaseType(property, via, context);
}

/**
 * Read the lift descriptor from an operator-direct
 * `term(prop(via))` value expression. Comparisons and `between`
 * bounds use this narrow read before the recursive native-function
 * walk because a direct property on the RHS needs an operator-
 * direction swap when it moves to an envelope's inner LHS.
 */
function readDirectViaPropFromValueExpression(
	expr: ValueExpression,
	context: RelationReadNormalizationContext,
): { via: RelationPath; propWithoutVia: PropertyRef } | undefined {
	if (expr.kind !== "term") return undefined;
	const term = expr.term;
	if (term.kind !== "prop") return undefined;
	return readViaFromPropertyRef(term, context);
}

type ValueExpressionViaLift =
	| {
			lifted: false;
			expression: ValueExpression;
	  }
	| {
			lifted: true;
			via: RelationPath;
			expression: ValueExpression;
	  };

/**
 * Strip the first non-self PropertyRef via reachable through a
 * CSQL-native ValueExpression and return the relation path alongside
 * the rebuilt expression. The predicate-level caller places that
 * path on an `exists` envelope and recurses, so additional vias lift
 * one at a time without mutating the authored AST.
 *
 * The traversal mirrors `isCsqlValueFunctionArm` and
 * `emitCsqlExpressionSegments`: `term`, date/datetime coercion,
 * `double`, `date-add`, and `unwrap-list` reach the native CSQL term
 * emitter. Non-native roots (`arith`, `concat`, `coalesce`, `if`,
 * `switch`, `count`, `format-date`) deliberately stop here because
 * `inlineAsRuntimeOperand` evaluates them through the on-device
 * emitter, which already retains PropertyRef.via in its XPath.
 */
function liftFirstViaInCsqlValueExpression(
	expr: ValueExpression,
	context: RelationReadNormalizationContext,
): ValueExpressionViaLift {
	switch (expr.kind) {
		case "term": {
			if (expr.term.kind !== "prop") {
				return { lifted: false, expression: expr };
			}
			const propVia = readViaFromPropertyRef(expr.term, context);
			if (propVia === undefined) {
				return { lifted: false, expression: expr };
			}
			return {
				lifted: true,
				via: propVia.via,
				expression: { kind: "term", term: propVia.propWithoutVia },
			};
		}
		case "today":
		case "now":
		case "id-of":
		case "acting-user":
		case "unowned":
		case "table-lookup":
			return { lifted: false, expression: expr };
		case "date-coerce":
		case "datetime-coerce":
		case "double":
		case "unwrap-list": {
			const child = liftFirstViaInCsqlValueExpression(expr.value, context);
			if (!child.lifted) {
				return { lifted: false, expression: expr };
			}
			return {
				lifted: true,
				via: child.via,
				expression: { kind: expr.kind, value: child.expression },
			};
		}
		case "date-add": {
			const date = liftFirstViaInCsqlValueExpression(expr.date, context);
			if (date.lifted) {
				return {
					lifted: true,
					via: date.via,
					expression: { ...expr, date: date.expression },
				};
			}
			const quantity = liftFirstViaInCsqlValueExpression(
				expr.quantity,
				context,
			);
			if (!quantity.lifted) {
				return { lifted: false, expression: expr };
			}
			return {
				lifted: true,
				via: quantity.via,
				expression: { ...expr, quantity: quantity.expression },
			};
		}
		case "arith":
		case "concat":
		case "coalesce":
		case "if":
		case "switch":
		case "count":
		case "format-date":
			return { lifted: false, expression: expr };
		default: {
			const _exhaustive: never = expr;
			throw new Error(
				`normalizeRelationPropertyReads: hit an unhandled ValueExpression kind '${String(_exhaustive)}'. Decide whether the new arm is predicate-native or scalar before extending this dispatch.`,
			);
		}
	}
}
