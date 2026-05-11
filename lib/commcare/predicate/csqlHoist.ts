// lib/commcare/predicate/csqlHoist.ts
//
// Property-via lift pre-pass for CSQL emission. CCHQ's CSQL grammar
// exposes relational reads ONLY through the `ancestor-exists` /
// `subcase-exists` query functions registered on
// `commcare-hq/corehq/apps/case_search/xpath_functions/__init__.py::XPATH_QUERY_FUNCTIONS`;
// it has no inline relational-read shape on a property reference.
// This pass rewrites every operator-direct `prop(via)` reference into
// an enclosing `exists` envelope whose inner predicate carries the
// same operator with the property's via flipped to self. After the
// rewrite every property reference reaching the segment emitter has
// `via.kind === "self"` (or no `via` slot); the relation walk has
// been hoisted to the envelope where it emits as CCHQ's direction-
// specific query function.
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
//   - `ValueExpression`-wrapped as `term(prop(via))` in operand
//     slots: `compare.{left,right}`, `in.left`,
//     `between.{left,lower,upper}`, `is-null.left`, `is-blank.left`,
//     `within-distance.center`.
//
// The walker handles both shapes uniformly via `liftPredicateVias`,
// which dispatches per operator arm and rebuilds the predicate when
// a via lifts. The walk recurses into structural predicate-bearing
// slots (`and.clauses`, `or.clauses`, `not.clause`,
// `when-input-present.clause`, `exists.where`, `missing.where`) so
// vias nested inside logical operators surface. The walk does NOT
// recurse into ValueExpression sub-arms (`arith`, `if`, `concat`,
// etc.) — those expressions inline as on-device XPath fragments at
// the CSQL emission layer, where the on-device emitter handles
// `via` on the property reference correctly at the term layer.
//
// Idempotence: the rewrite is structurally cycle-free. Each call to
// `liftPredicateVias` strips at most one operator-direct via per
// recursive invocation (the new envelope's inner `where` contains
// the operator with the via gone), and the recursive descent reaches
// the inner `where` and re-runs. A second top-level `liftPropertyVias`
// over the result produces the same output — no vias remain to lift.
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

import type {
	ComparisonKind,
	Predicate,
	PropertyRef,
	RelationPath,
	ValueExpression,
} from "@/lib/domain/predicate/types";

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
export function liftPropertyVias(predicate: Predicate): Predicate {
	return liftPredicateVias(predicate);
}

/**
 * Per-operator dispatcher for the via-lift walk. Each operator arm
 * either (a) detects a via on its property slot and returns the
 * `exists`-wrapped rewrite, (b) recurses into structural
 * predicate-bearing children and rebuilds, or (c) passes through
 * unchanged (sentinels).
 */
function liftPredicateVias(p: Predicate): Predicate {
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
			return liftComparisonVias(p);
		case "in":
			return liftInVias(p);
		case "between":
			return liftBetweenVias(p);
		case "is-null":
		case "is-blank":
			return liftAbsenceVias(p);
		case "match":
			return liftMatchVias(p);
		case "multi-select-contains":
			return liftMultiSelectVias(p);
		case "within-distance":
			return liftWithinDistanceVias(p);
		case "and":
			return {
				kind: "and",
				clauses: p.clauses.map((c) => liftPredicateVias(c)) as [
					Predicate,
					...Predicate[],
				],
			};
		case "or":
			return {
				kind: "or",
				clauses: p.clauses.map((c) => liftPredicateVias(c)) as [
					Predicate,
					...Predicate[],
				],
			};
		case "not":
			return { kind: "not", clause: liftPredicateVias(p.clause) };
		case "when-input-present":
			return {
				kind: "when-input-present",
				input: p.input,
				clause: liftPredicateVias(p.clause),
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
			return { kind: p.kind, via: p.via, where: liftPredicateVias(p.where) };
		}
		default: {
			const _exhaustive: never = p;
			throw new Error(
				`csqlHoist: hit an unhandled predicate kind '${String(_exhaustive)}' while lifting relational property reads into exists envelopes. Expected one of the kinds listed on the Predicate union in lib/domain/predicate/types.ts. Look at whoever added the kind — they need to extend the via-lift dispatch.`,
			);
		}
	}
}

/**
 * Lift property vias inside a comparison's operand pair. The two
 * operand slots are symmetric `ValueExpression` slots; either side
 * may carry a `term(prop(via))` or a `count(via, where=...)` whose
 * inner `where` clause references property-vias. The rewrite picks
 * LHS first when both carry a via — recursion into the rewritten
 * envelope's inner `where` reaches the RHS via on the next pass.
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
): Predicate {
	const leftViaProp = readViaPropFromValueExpression(p.left);
	if (leftViaProp !== undefined) {
		const { via, propWithoutVia } = leftViaProp;
		// Recurse so a via on the RHS (or a second via on the inner
		// `where`) lifts on the next pass.
		const inner = liftPredicateVias({
			kind: p.kind,
			left: { kind: "term", term: propWithoutVia },
			right: p.right,
		});
		return wrapInExists(via, inner);
	}
	const rightViaProp = readViaPropFromValueExpression(p.right);
	if (rightViaProp !== undefined) {
		const { via, propWithoutVia } = rightViaProp;
		if (p.kind === "eq" || p.kind === "neq") {
			// Symmetric operators preserve operand order — the inner
			// comparison keeps `<original-left> <op> <prop>`, matching
			// the authored shape. Both CSQL and on-device evaluators
			// treat the two sides equivalently for symmetric ops.
			const inner = liftPredicateVias({
				kind: p.kind,
				left: p.left,
				right: { kind: "term", term: propWithoutVia },
			});
			return wrapInExists(via, inner);
		}
		// Asymmetric operators swap when the property moves from
		// the RHS to the inner LHS so the comparison direction
		// stays intact — `gt(a, prop(via))` reads "a > <related
		// prop>", which is equivalent to "<related prop> < a" —
		// i.e. `lt(prop, a)` inside the envelope.
		const innerKind = ASYMMETRIC_COMPARISON_SWAP[p.kind];
		const inner = liftPredicateVias({
			kind: innerKind,
			left: { kind: "term", term: propWithoutVia },
			right: p.left,
		});
		return wrapInExists(via, inner);
	}
	// Walk into `count.where` clauses on either operand. The CSQL
	// emitter splices the `where` argument's segment list into
	// the surrounding `subcase-count(...)` call, so a via inside
	// the `where` reaches the property-ref emitter directly; the
	// pre-pass needs to lift those vias before emission runs.
	const liftedLeft = liftViaInCountWhere(p.left);
	const liftedRight = liftViaInCountWhere(p.right);
	if (liftedLeft !== p.left || liftedRight !== p.right) {
		return { kind: p.kind, left: liftedLeft, right: liftedRight };
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
function liftViaInCountWhere(expr: ValueExpression): ValueExpression {
	if (expr.kind !== "count" || expr.where === undefined) return expr;
	const liftedWhere = liftPredicateVias(expr.where);
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
function liftInVias(p: Extract<Predicate, { kind: "in" }>): Predicate {
	const leftViaProp = readViaPropFromValueExpression(p.left);
	if (leftViaProp === undefined) return p;
	const { via, propWithoutVia } = leftViaProp;
	const inner = liftPredicateVias({
		kind: "in",
		left: { kind: "term", term: propWithoutVia },
		values: p.values,
	});
	return wrapInExists(via, inner);
}

/**
 * Lift property vias inside a `between`. The three slots
 * (`left`, `lower`, `upper`) each carry a `ValueExpression`; the
 * walker picks the first one with a via and recurses so a second
 * via on a remaining slot lifts on the next pass.
 *
 * The schema rejects the both-bounds-absent shape; the rebuild
 * preserves the conditional-spread shape so the absent-key contract
 * stays intact through the lift.
 */
function liftBetweenVias(
	p: Extract<Predicate, { kind: "between" }>,
): Predicate {
	const leftViaProp = readViaPropFromValueExpression(p.left);
	if (leftViaProp !== undefined) {
		const { via, propWithoutVia } = leftViaProp;
		const inner = liftPredicateVias({
			kind: "between",
			left: { kind: "term", term: propWithoutVia },
			...(p.lower !== undefined ? { lower: p.lower } : {}),
			...(p.upper !== undefined ? { upper: p.upper } : {}),
			lowerInclusive: p.lowerInclusive,
			upperInclusive: p.upperInclusive,
		});
		return wrapInExists(via, inner);
	}
	if (p.lower !== undefined) {
		const lowerViaProp = readViaPropFromValueExpression(p.lower);
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
			const inner = liftPredicateVias({
				kind: op,
				left: { kind: "term", term: propWithoutVia },
				right: p.left,
			});
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
			const others: Predicate = liftPredicateVias({
				kind: "between",
				left: p.left,
				upper: p.upper,
				lowerInclusive: p.lowerInclusive,
				upperInclusive: p.upperInclusive,
			});
			return {
				kind: "and",
				clauses: [wrapInExists(via, inner), others],
			};
		}
	}
	if (p.upper !== undefined) {
		const upperViaProp = readViaPropFromValueExpression(p.upper);
		if (upperViaProp !== undefined) {
			// Symmetric to the `lower`-bound rewrite: original
			// `left <= U` becomes `U_prop >= left` inside the
			// envelope (the direction flips when the bound moves
			// to the inner LHS).
			const { via, propWithoutVia } = upperViaProp;
			const op: ComparisonKind = p.upperInclusive ? "gte" : "gt";
			const inner = liftPredicateVias({
				kind: op,
				left: { kind: "term", term: propWithoutVia },
				right: p.left,
			});
			// `upper`-only branch: `lower` was either absent or
			// already via-free (the LHS-via lift above handles the
			// LHS case). Both-bounds-absent is unreachable per the
			// schema refine.
			if (p.lower === undefined) {
				return wrapInExists(via, inner);
			}
			const lowerOnly: Predicate = liftPredicateVias({
				kind: "between",
				left: p.left,
				lower: p.lower,
				lowerInclusive: p.lowerInclusive,
				upperInclusive: p.upperInclusive,
			});
			return {
				kind: "and",
				clauses: [wrapInExists(via, inner), lowerOnly],
			};
		}
	}
	return p;
}

/**
 * Lift property vias on `is-null.left` / `is-blank.left`. Single
 * operand; the rewrite mirrors the LHS lift on comparisons.
 */
function liftAbsenceVias(
	p: Extract<Predicate, { kind: "is-null" | "is-blank" }>,
): Predicate {
	const leftViaProp = readViaPropFromValueExpression(p.left);
	if (leftViaProp === undefined) return p;
	const { via, propWithoutVia } = leftViaProp;
	const inner = liftPredicateVias({
		kind: p.kind,
		left: { kind: "term", term: propWithoutVia },
	});
	return wrapInExists(via, inner);
}

/**
 * Lift the via on `match.property`. `match.property` is a direct
 * `PropertyRef` slot — the type checker constrains it to a
 * `propertyRefSchema` per `matchSchema` in
 * `lib/domain/predicate/types.ts`. The lift envelope carries the
 * relation walk; the inner `match` retains the same mode and value.
 *
 * The value side is left as-is. A via on `match.value` would be a
 * separate cross-cutting concern; the on-device emitter currently
 * handles it (via the term emitter's relation-walk anchor) but the
 * CSQL emitter would still drop the via on the value's property.
 * Authoring shape: `match.value` is almost always a runtime input
 * ref / literal / session ref, so the case where a via on
 * `match.value` matters in practice is vanishingly rare.
 */
function liftMatchVias(p: Extract<Predicate, { kind: "match" }>): Predicate {
	const propVia = readViaFromPropertyRef(p.property);
	if (propVia === undefined) return p;
	const { via, propWithoutVia } = propVia;
	const inner = liftPredicateVias({
		kind: "match",
		property: propWithoutVia,
		value: p.value,
		mode: p.mode,
	});
	return wrapInExists(via, inner);
}

/**
 * Lift the via on `multi-select-contains.property`. Same shape as
 * `liftMatchVias`: the direct `PropertyRef` slot moves to the
 * envelope, the inner operator retains its quantifier + values.
 */
function liftMultiSelectVias(
	p: Extract<Predicate, { kind: "multi-select-contains" }>,
): Predicate {
	const propVia = readViaFromPropertyRef(p.property);
	if (propVia === undefined) return p;
	const { via, propWithoutVia } = propVia;
	const inner = liftPredicateVias({
		kind: "multi-select-contains",
		property: propWithoutVia,
		values: p.values,
		quantifier: p.quantifier,
	});
	return wrapInExists(via, inner);
}

/**
 * Lift the via on `within-distance.property`. Only the direct
 * `PropertyRef` slot lifts here — the `center` ValueExpression
 * carries the geopoint the test measures against, and CCHQ's
 * `within-distance` parses its second argument through
 * `GeoPoint.from_string` at
 * `commcare-hq/corehq/apps/case_search/xpath_functions/query_functions.py::within_distance`,
 * so a related-case property reference in `center` has no valid
 * inline wire form (the property name would parse as a literal
 * coordinate string and fail). Authors who want "within distance of
 * a related case's geopoint" express the intent via an
 * `exists`-wrapped predicate at the authoring layer; the via-lift
 * does not synthesize that envelope from a `center`-via shape.
 */
function liftWithinDistanceVias(
	p: Extract<Predicate, { kind: "within-distance" }>,
): Predicate {
	const propVia = readViaFromPropertyRef(p.property);
	if (propVia === undefined) return p;
	const { via, propWithoutVia } = propVia;
	const inner = liftPredicateVias({
		kind: "within-distance",
		property: propWithoutVia,
		center: p.center,
		distance: p.distance,
		unit: p.unit,
	});
	return wrapInExists(via, inner);
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
 *   - `self`: unreachable from `readViaFromPropertyRef` /
 *     `readViaPropFromValueExpression` (both filter `self` out at
 *     the read site); the throw is a structural defense.
 */
function wrapInExists(via: RelationPath, inner: Predicate): Predicate {
	switch (via.kind) {
		case "ancestor":
		case "subcase":
			return { kind: "exists", via, where: inner };
		case "any-relation": {
			const ancestor: RelationPath = {
				kind: "ancestor",
				via: [{ identifier: via.identifier }],
			};
			const subcase: RelationPath = {
				kind: "subcase",
				identifier: via.identifier,
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
				"csqlHoist: tried to wrap a predicate in an exists envelope on a self-walk relation, but self carries no traversal — the wrap helper should never see this shape. Look at the readVia helpers; they filter self before reaching here.",
			);
		default: {
			const _exhaustive: never = via;
			throw new Error(
				`csqlHoist: hit an unhandled RelationPath kind '${String(_exhaustive)}' while wrapping a relational comparison in an exists envelope. Expected ancestor, subcase, any-relation, or self. Whoever added the kind needs to extend the wrap dispatch.`,
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
): { via: RelationPath; propWithoutVia: PropertyRef } | undefined {
	const via = prop.via;
	if (via === undefined || via.kind === "self") return undefined;
	const propWithoutVia: PropertyRef = {
		kind: "prop",
		caseType: prop.caseType,
		property: prop.property,
	};
	return { via, propWithoutVia };
}

/**
 * Read the lift descriptor from a `term(prop(via))` value
 * expression. Returns `undefined` for any other shape — the via
 * lift acts only on operator-direct term-arm property references;
 * vias nested inside `arith` / `if` / `concat` / etc. ride into
 * the CSQL emission inline as on-device XPath fragments, where the
 * on-device emitter's relation-walk anchor handles them.
 */
function readViaPropFromValueExpression(
	expr: ValueExpression,
): { via: RelationPath; propWithoutVia: PropertyRef } | undefined {
	if (expr.kind !== "term") return undefined;
	const term = expr.term;
	if (term.kind !== "prop") return undefined;
	return readViaFromPropertyRef(term);
}
