// lib/commcare/predicate/csqlHoist.ts
//
// AST → AST normalization pipeline that produces a CSQL-emission-
// compatible Predicate. Two passes compose:
//
//   1. **Property-via lift** (`liftPropertyVias`). Every operator-
//      direct property reference whose `via` walks a relation
//      (`ancestor` / `subcase` / `any-relation`) lifts into an
//      enclosing `exists` envelope. CCHQ's CSQL grammar has no
//      inline relational-read shape — the comparison-LHS slash-path
//      form (`<rel>/<prop> = <value>`) is recognised by CCHQ's
//      `is_ancestor_comparison` at
//      `commcare-hq/corehq/apps/case_search/xpath_functions/ancestor_functions.py::is_ancestor_comparison`,
//      but Nova never emits it: the canonical CSQL surface for
//      relational reads is `ancestor-exists` / `subcase-exists`
//      with the property comparison expressed inside the envelope's
//      filter argument. After this pass, every `prop(via)` reaching
//      the segment emitter has `via.kind === "self"` (or no `via`
//      slot); the relation walk has been hoisted to the envelope.
//
//   2. **Value-expression hoist** (`walkPredicate`). Every value
//      expression CSQL cannot represent inline lifts out of the
//      predicate, replacing the lifted node with a synthetic
//      search-input reference and recording the original
//      `ValueExpression` as a wrapper the on-device XPath builds
//      before the CSQL fragment is interpolated.
//
// CSQL's two function whitelists on
// `commcare-hq/corehq/apps/case_search/xpath_functions/__init__.py::XPATH_VALUE_FUNCTIONS`
// and `__init__.py::XPATH_QUERY_FUNCTIONS` register the inner CSQL
// fragment's vocabulary: 8 value functions (`date`, `date-add`,
// `datetime`, `datetime-add`, `double`, `now`, `today`, `unwrap-list`)
// plus 14 query functions. Every other shape — conditionals (`if`, `switch`),
// arithmetic (`arith`), string concatenation (`concat`, `coalesce`),
// `count(...)` outside the comparison-LHS slot CCHQ recognises as
// `subcase-count`, on-device formatting (`format-date`) — lifts into
// an on-device wrapper expression that runs at runtime and produces
// a string injected into the CSQL fragment via a synthetic
// search-input ref.
//
// `date-coerce` and `datetime-coerce` AST kinds correspond to CSQL's
// `date` / `datetime` value functions; the names diverge between the
// authoring AST and the wire vocabulary. The hoist pass leaves them
// intact and the emitter performs the rename at output time.
//
// The pattern follows CCHQ's canonical examples documented in
// `commcare-hq/docs/case_search_query_language.rst`: an outer XPath
// `concat(...)` builds the CSQL string from constant fragments and
// runtime-resolved instance reads. The hoist pass generalises that
// pattern to every non-grammar shape.
//
// The pass is total: every input AST produces a CSQL-emission-
// compatible output AST plus a wrapper list. There is no error
// surface; whatever the AST contains, the via-lift + hoist + emit
// pipeline produces faithful CSQL output.
//
// `when-input-present(trigger, clause)` is preserved through the
// hoist pass; the emitter handles it directly by emitting the
// canonical CCHQ pattern documented in
// `commcare-hq/docs/case_search_query_language.rst`:
// `if(count(<trigger-xpath>), <clause-csql>, 'match-all()')`. The
// hoist still walks the inner clause so any nested non-grammar value
// expression lifts normally; the trigger ref and the conditional
// dispatch live at the emitter layer because they require recursive
// CSQL emission of the inner clause to produce its concat-wrapper
// XPath expression.
//
// `is-null` and `is-blank` rewrite to the same wire form on CSQL
// (`<term> = ''`); the rewrite happens at the emitter, not here, so
// the hoist pass leaves both intact.
//
// `count(via, where)` outside a comparison-LHS subcase position
// lifts as a wrapper expression. The wire layer evaluates the count
// on-device and injects the resolved number into the CSQL fragment
// via the synthetic search-input ref.
//
// Mutation-safety contract: the input AST is never mutated. Returned
// subtrees are either fresh objects (every arm that rebuilds, every
// lift site) or shared with the input by reference (the leaf arms
// for terms, sentinels, and grammar-only ValueExpressions where no
// descendant lifts). Consumers may compose the hoist result with
// other AST work without disturbing the input.

import type {
	ComparisonKind,
	Predicate,
	PropertyRef,
	RelationPath,
	SearchInputRef,
	ValueExpression,
} from "@/lib/domain/predicate/types";

/**
 * Position discriminator threaded through the hoist walk so the count
 * arm can decide whether to lift or leave based on its enclosing
 * context.
 *
 *   - `comparison-operand` — directly underneath one of the six
 *     comparison operators. `count` with `via.kind === "subcase"`
 *     survives here as native `subcase-count(...)` per CCHQ's
 *     `_is_subcase_count` recogniser nested inside
 *     `commcare-hq/corehq/apps/case_search/filter_dsl.py::build_filter_from_ast`.
 *     Other count shapes still lift into the wrapper.
 *   - `value` — every other ValueExpression slot. All count shapes
 *     lift; grammar value functions survive intact.
 */
type HoistPosition = "comparison-operand" | "value";

/**
 * A single lifted value expression. `inputRef` is the synthetic
 * search-input ref name that replaces the lifted node in the
 * transformed AST; `expression` is the original ValueExpression that
 * runs on-device before CSQL emission and produces the runtime
 * string interpolated into the CSQL fragment.
 *
 * The wire layer emits one `<data>` element per wrapper before the
 * CSQL data element so the wrapper inputs resolve before the CSQL
 * fragment does. The CSQL fragment references the synthetic name via
 * the standard search-input wire path
 * (`instance('search-input:results')/input/field[@name='<name>']`),
 * so downstream evaluation reads the runtime-built string in place of
 * the lifted expression.
 */
export interface HoistedWrapper {
	readonly inputRef: string;
	readonly expression: ValueExpression;
}

/**
 * Result of the hoist pass: the rewritten predicate AST plus the
 * list of lifted wrapper expressions. The pass is total — every
 * input predicate produces a CSQL-emission-compatible output, with
 * any non-grammar shapes lifted into the wrapper list.
 */
export interface CsqlHoistResult {
	readonly hoisted: Predicate;
	readonly wrappers: readonly HoistedWrapper[];
}

/**
 * Synthetic input-ref name prefix. The letter-prefixed name keeps the
 * synthetic ref valid as a search-input `name` per the schema's XML
 * element-name vocabulary; the deterministic numeric suffix gives
 * stable round-trip shape for testability.
 *
 * The prefix's purpose is collision avoidance with author-written
 * input refs. `seedNextIndex` walks the input AST before the hoist
 * walk and seeds the synthetic counter past any author-written
 * `csql_hoist_<n>` reference, so a synthetic name never shadows an
 * existing author ref. Authors who deliberately use the prefix get
 * their refs respected; the synthetic counter starts past the highest
 * author-supplied index.
 */
const HOIST_INPUT_NAME_PREFIX = "csql_hoist_";

/**
 * Walker state: the next synthetic-name index and the accumulated
 * wrapper list. The function-private mutability is encapsulated —
 * `hoistForCsql` constructs a fresh state per call and returns
 * immutable views, so callers see the same purely-functional surface
 * a multi-return tuple would offer.
 */
interface HoistState {
	nextIndex: number;
	wrappers: HoistedWrapper[];
}

/**
 * Top-level entry point. Runs the via-lift pre-pass, then the
 * value-expression hoist walk, and returns the rewritten AST plus the
 * wrapper list. `when-input-present` predicates pass through
 * unchanged (the emitter handles them via recursive CSQL emission
 * and the canonical
 * `if(count(<trigger>), <inner-csql>, 'match-all()')` wrapper).
 *
 * Two passes compose:
 *
 *   1. `liftPropertyVias` rewrites every operator-direct
 *      `prop(via)` reference into an enclosing `exists` envelope so
 *      the relation walk emits via CCHQ's `ancestor-exists` /
 *      `subcase-exists` query functions. After this pass, every
 *      `prop` reaching the segment emitter has no non-self `via`.
 *   2. `walkPredicate` lifts non-grammar value expressions into
 *      synthetic input refs, recording each lift as a wrapper
 *      expression evaluated on-device before the CSQL fragment.
 *
 * Splitting the two passes keeps each one's recursion shape
 * focused: the via-lift is a Predicate→Predicate reshape with no
 * wrapper-state interaction; the value-expression hoist threads the
 * synthetic-name counter through the walk.
 *
 * Before walking, `seedNextIndex` scans the via-lifted predicate
 * for author-written `csql_hoist_<n>` references and starts the
 * synthetic counter past the highest one found. The seed-and-scan
 * keeps synthetic refs distinct from author refs even when authors
 * deliberately use the prefix.
 *
 * The input predicate is never mutated. The wrapper list preserves
 * the order lifted nodes were encountered during the walk, so naming
 * is deterministic for testability.
 */
export function hoistForCsql(predicate: Predicate): CsqlHoistResult {
	const viaLifted = liftPropertyVias(predicate);
	const state: HoistState = {
		nextIndex: seedNextIndex(viaLifted),
		wrappers: [],
	};
	const hoisted = walkPredicate(viaLifted, state);
	return {
		hoisted,
		wrappers: state.wrappers,
	};
}

// ============================================================
// Property-via lift (pre-pass)
// ============================================================
//
// CCHQ's CSQL grammar exposes relational reads ONLY through the
// `ancestor-exists` / `subcase-exists` query functions; there is no
// inline "read <prop> on a related case" wire form the emitter
// targets. (CCHQ's parser does recognise a `<rel>/<prop> = <value>`
// shape on the comparison's left side via `is_ancestor_comparison`
// at
// `commcare-hq/corehq/apps/case_search/xpath_functions/ancestor_functions.py::is_ancestor_comparison`,
// but Nova does not emit that shape — staying on the single canonical
// envelope form keeps the wire surface consistent across operators
// and avoids per-operator branching on "does this operator's slot
// admit the slash-path form?".)
//
// The via-lift rewrites every operator-direct `prop(via)` reference
// into an enclosing `exists` envelope whose inner predicate carries
// the same operator with the property's via flipped to self. The
// destination case type comes from the `via`'s schema-resolved
// destination — but the inner property's `caseType` slot keeps the
// outer scope's value at this layer because no downstream consumer
// of the hoisted AST reads it (the CSQL emitter resolves property
// names against the envelope's via at runtime; the type checker has
// already run on the authored AST upstream of `emitCsql`).
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
// etc.) — those expressions lift to on-device wrappers in the
// value-expression hoist pass, and the on-device emitter handles
// `via` on the property reference correctly at that layer.
//
// Idempotence: the rewrite is structurally cycle-free. Each call to
// `liftPredicateVias` strips at most one operator-direct via per
// recursive invocation (the new envelope's inner `where` contains
// the operator with the via gone), and the recursive descent reaches
// the inner `where` and re-runs. A second top-level `liftPropertyVias`
// over the result produces the same output — no vias remain to lift.

/**
 * Pre-pass: walk the predicate tree and lift every operator-direct
 * `prop(via)` reference into an enclosing `exists` envelope. After
 * this pass, every property reference reaching the segment emitter
 * has `via.kind === "self"` (or no `via` slot); the relation walk
 * has been hoisted to the envelope where it emits via CCHQ's
 * direction-specific query functions.
 *
 * The function is total: every input predicate produces an output
 * predicate whose operator-direct property references are
 * via-free.
 */
function liftPropertyVias(predicate: Predicate): Predicate {
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
				`csqlHoist: unhandled predicate kind in via-lift ${String(_exhaustive)}`,
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
 * direction `count` survives the value-expression hoist in
 * comparison-LHS position as native `subcase-count(...)`, and its
 * `where` argument runs through the CSQL predicate emitter at
 * emission time — so a `prop(via)` inside the `where` would
 * otherwise drop its relation walk at the segment emitter.
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
 * run the via-lift recursively. The `count` arm survives the
 * value-expression hoist only in comparison-LHS position with
 * `subcase` direction (CCHQ's `_is_subcase_count` recogniser),
 * but the via-lift runs before the value-expression hoist, so the
 * pre-pass can't yet tell which `count`s survive — it walks into
 * every `count.where` it sees. `count` shapes that subsequently
 * lift as on-device wrappers compile through `emitOnDeviceExpression`,
 * which handles property-vias correctly at the term layer; the
 * extra rewrite is a no-op for those cases (the `where` clause
 * runs through the on-device emitter regardless of via shape).
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
				"csqlHoist: wrapInExists received via.kind === 'self'; the readVia helpers filter self before reaching here.",
			);
		default: {
			const _exhaustive: never = via;
			throw new Error(
				`csqlHoist: unhandled RelationPath kind in via-lift ${String(_exhaustive)}`,
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
 * the input — see the file-level comment for why the inner
 * `caseType` is not retargeted to the via's destination case type.
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
 * vias nested inside `arith` / `if` / `concat` / etc. are handled
 * by the value-expression hoist (which lifts the entire surrounding
 * expression as an on-device wrapper that resolves the via via the
 * on-device emitter's relation-walk anchor).
 */
function readViaPropFromValueExpression(
	expr: ValueExpression,
): { via: RelationPath; propWithoutVia: PropertyRef } | undefined {
	if (expr.kind !== "term") return undefined;
	const term = expr.term;
	if (term.kind !== "prop") return undefined;
	return readViaFromPropertyRef(term);
}

// ============================================================
// Value-expression hoist (main pass)
// ============================================================

/**
 * Scan the input predicate for author-written input refs that share
 * the synthetic prefix and return the first synthetic index past the
 * highest one found. Returning 0 when no collision exists keeps the
 * default naming dense (`csql_hoist_0`, `csql_hoist_1`, ...); a
 * single conflicting `csql_hoist_5` author ref shifts the synthetic
 * counter to 6 so the first lift becomes `csql_hoist_6`.
 *
 * The scan visits every search-input ref reachable via terms; the
 * walker is a separate pass from the rewriting walker so the
 * rewriting walker can rely on a fixed seed throughout its descent.
 */
function seedNextIndex(predicate: Predicate): number {
	const collisions: number[] = [];
	collectInputRefIndices(predicate, collisions);
	if (collisions.length === 0) return 0;
	return Math.max(...collisions) + 1;
}

/**
 * Recursive scan over the predicate tree collecting numeric suffixes
 * from any author-written `csql_hoist_<n>` input ref. Operates only
 * on input-ref terms; other terms / value expressions are walked
 * structurally to find the input refs nested inside them.
 */
function collectInputRefIndices(p: Predicate, out: number[]): void {
	switch (p.kind) {
		case "match-all":
		case "match-none":
			return;
		case "eq":
		case "neq":
		case "gt":
		case "gte":
		case "lt":
		case "lte":
			collectFromValueExpression(p.left, out);
			collectFromValueExpression(p.right, out);
			return;
		case "in":
			collectFromValueExpression(p.left, out);
			return;
		case "within-distance":
			collectFromValueExpression(p.center, out);
			return;
		case "match":
		case "multi-select-contains":
			return;
		case "is-null":
		case "is-blank":
			collectFromValueExpression(p.left, out);
			return;
		case "between":
			collectFromValueExpression(p.left, out);
			if (p.lower !== undefined) collectFromValueExpression(p.lower, out);
			if (p.upper !== undefined) collectFromValueExpression(p.upper, out);
			return;
		case "and":
		case "or":
			for (const c of p.clauses) collectInputRefIndices(c, out);
			return;
		case "not":
			collectInputRefIndices(p.clause, out);
			return;
		case "when-input-present":
			collectInputRefIndex(p.input.name, out);
			collectInputRefIndices(p.clause, out);
			return;
		case "exists":
		case "missing":
			if (p.where !== undefined) collectInputRefIndices(p.where, out);
			return;
		default: {
			const _exhaustive: never = p;
			throw new Error(
				`csqlHoist: unhandled predicate kind in collector ${String(_exhaustive)}`,
			);
		}
	}
}

/**
 * Recursive scan over a ValueExpression collecting input-ref
 * collision indices. Term refs of `kind: "input"` go through
 * `collectInputRefIndex`; nested value expressions recurse.
 */
function collectFromValueExpression(
	expr: ValueExpression,
	out: number[],
): void {
	switch (expr.kind) {
		case "term":
			if (expr.term.kind === "input") {
				collectInputRefIndex(expr.term.name, out);
			}
			return;
		case "today":
		case "now":
			return;
		case "date-add":
			collectFromValueExpression(expr.date, out);
			collectFromValueExpression(expr.quantity, out);
			return;
		case "date-coerce":
		case "datetime-coerce":
		case "double":
		case "unwrap-list":
			collectFromValueExpression(expr.value, out);
			return;
		case "format-date":
			collectFromValueExpression(expr.date, out);
			return;
		case "arith":
			collectFromValueExpression(expr.left, out);
			collectFromValueExpression(expr.right, out);
			return;
		case "concat":
			for (const part of expr.parts) collectFromValueExpression(part, out);
			return;
		case "coalesce":
			for (const v of expr.values) collectFromValueExpression(v, out);
			return;
		case "if":
			collectInputRefIndices(expr.cond, out);
			collectFromValueExpression(expr.then, out);
			collectFromValueExpression(expr.else, out);
			return;
		case "switch":
			collectFromValueExpression(expr.on, out);
			for (const c of expr.cases) collectFromValueExpression(c.then, out);
			collectFromValueExpression(expr.fallback, out);
			return;
		case "count":
			if (expr.where !== undefined) collectInputRefIndices(expr.where, out);
			return;
		default: {
			const _exhaustive: never = expr;
			throw new Error(
				`csqlHoist: unhandled value expression kind in collector ${String(_exhaustive)}`,
			);
		}
	}
}

/**
 * Append the numeric suffix from `<prefix><digits>` if `name` matches
 * the synthetic-prefix shape and the suffix parses as a non-negative
 * integer. Names that share the prefix but carry non-numeric suffixes
 * (e.g. `csql_hoist_foo`) don't enter the seed math; they remain
 * distinct from synthetic refs naturally because synthetic suffixes
 * are always numeric.
 */
function collectInputRefIndex(name: string, out: number[]): void {
	if (!name.startsWith(HOIST_INPUT_NAME_PREFIX)) return;
	const suffix = name.slice(HOIST_INPUT_NAME_PREFIX.length);
	// `Number.parseInt` would accept `"5abc"`; require the entire
	// suffix to be a non-negative integer to avoid spurious matches.
	if (!/^\d+$/.test(suffix)) return;
	const n = Number.parseInt(suffix, 10);
	if (Number.isFinite(n)) out.push(n);
}

/**
 * Recursive walker over the predicate union. Each operator arm
 * recurses into its operand slots and rebuilds the predicate node
 * fresh.
 *
 * `when-input-present(input, clause)` walks its inner clause for
 * value-expression hoisting but otherwise passes through unchanged;
 * the emitter handles the conditional-dispatch shape directly.
 *
 * `exists` / `missing` filters recurse normally — runtime refs
 * (input / session) inside the filter compose into the outer
 * `concat(...)` via the segment-list IR, matching CCHQ's documented
 * pattern at `case_search_query_language.rst::"Filtering on related cases" → "Examples"`
 * where a `subcase-exists("parent", ... clinic_case_id = "', instance(...),
 * '")')` interpolates a runtime user clinic id into the inner CSQL.
 */
function walkPredicate(p: Predicate, state: HoistState): Predicate {
	switch (p.kind) {
		case "match-all":
		case "match-none":
			return { kind: p.kind };
		case "eq":
		case "neq":
		case "gt":
		case "gte":
		case "lt":
		case "lte":
			return {
				kind: p.kind,
				left: walkValueExpression(p.left, state, "comparison-operand"),
				right: walkValueExpression(p.right, state, "comparison-operand"),
			};
		case "in":
			// `in.values` is a tuple of literals — no recursion required
			// (literals have no descendant ValueExpression slots). Only
			// `left` walks. The `values` array is reused by reference;
			// the schema guarantees the contents are immutable Literal
			// objects.
			return {
				kind: "in",
				left: walkValueExpression(p.left, state, "value"),
				values: p.values,
			};
		case "within-distance":
			// `within-distance.center` is a ValueExpression slot;
			// `property` is a direct PropertyRef and skips the walk.
			return {
				kind: "within-distance",
				property: p.property,
				center: walkValueExpression(p.center, state, "value"),
				distance: p.distance,
				unit: p.unit,
			};
		case "match":
		case "multi-select-contains":
			// `match.value` is a plain string and
			// `multi-select-contains.values` is a literal tuple — neither
			// carries a recursive ValueExpression slot, so the walker
			// returns the input by reference.
			return p;
		case "is-null":
		case "is-blank":
			return {
				kind: p.kind,
				left: walkValueExpression(p.left, state, "value"),
			};
		case "between":
			return rebuildBetween(p, state);
		case "and":
			return {
				kind: "and",
				clauses: p.clauses.map((c) => walkPredicate(c, state)) as [
					Predicate,
					...Predicate[],
				],
			};
		case "or":
			return {
				kind: "or",
				clauses: p.clauses.map((c) => walkPredicate(c, state)) as [
					Predicate,
					...Predicate[],
				],
			};
		case "not":
			return {
				kind: "not",
				clause: walkPredicate(p.clause, state),
			};
		case "when-input-present":
			// `when-input-present` is preserved through the hoist pass;
			// the emitter handles it directly via recursive emission of
			// the inner clause and the canonical
			// `if(count(<trigger-xpath>), <inner-csql>, 'match-all()')`
			// wrapper documented at
			// `case_search_query_language.rst::"Filtering on related cases" → "Examples"`.
			// The hoist still walks the inner clause so any nested
			// non-grammar value expressions lift normally.
			return {
				kind: "when-input-present",
				input: p.input,
				clause: walkPredicate(p.clause, state),
			};
		case "exists":
		case "missing": {
			const where =
				p.where !== undefined ? walkPredicate(p.where, state) : undefined;
			if (where === undefined) {
				return { kind: p.kind, via: p.via };
			}
			return { kind: p.kind, via: p.via, where };
		}
		default: {
			const _exhaustive: never = p;
			throw new Error(
				`csqlHoist: unhandled predicate kind ${String(_exhaustive)}`,
			);
		}
	}
}

/**
 * Rebuild a `between` predicate, threading each present bound through
 * the value-expression walker. The schema's `.refine()` guarantees at
 * least one of `lower` / `upper` is present; the rebuild preserves
 * the absent-key contract from the schema layer (no `lower: undefined`
 * or `upper: undefined` materialised). Three valid bound combinations
 * collapse to a single conditional-spread shape rather than four
 * cross-product branches.
 */
function rebuildBetween(
	p: Extract<Predicate, { kind: "between" }>,
	state: HoistState,
): Predicate {
	const left = walkValueExpression(p.left, state, "value");
	const lower =
		p.lower !== undefined
			? walkValueExpression(p.lower, state, "value")
			: undefined;
	const upper =
		p.upper !== undefined
			? walkValueExpression(p.upper, state, "value")
			: undefined;
	return {
		kind: "between",
		left,
		...(lower !== undefined ? { lower } : {}),
		...(upper !== undefined ? { upper } : {}),
		lowerInclusive: p.lowerInclusive,
		upperInclusive: p.upperInclusive,
	};
}

/**
 * Recursive walker over the value-expression union. Decides per-arm
 * whether to (a) leave the node intact (CSQL grammar arm) or (b) lift
 * it as a wrapper expression.
 *
 * CSQL's value-function whitelist on
 * `commcare-hq/corehq/apps/case_search/xpath_functions/__init__.py::XPATH_VALUE_FUNCTIONS`
 * registers exactly eight value functions: `date`, `date-add`,
 * `datetime`, `datetime-add`, `double`, `now`, `today`, `unwrap-list`.
 * Plus terms (which are not function calls). The AST's `date-coerce`
 * and `datetime-coerce` arms map to CSQL's `date` / `datetime` value
 * functions and survive the walk; the emitter performs the rename at
 * output time. Every other arm — including `format-date`, which
 * CCHQ's CSQL whitelist does not include — lifts into the wrapper.
 */
function walkValueExpression(
	expr: ValueExpression,
	state: HoistState,
	position: HoistPosition,
): ValueExpression {
	switch (expr.kind) {
		case "term":
			// Terms carry no recursive ValueExpression slot; the schema's
			// term union is flat. The walker returns the input by
			// reference.
			return expr;
		case "today":
		case "now":
			// CCHQ value functions registered on
			// `commcare-hq/corehq/apps/case_search/xpath_functions/__init__.py::XPATH_VALUE_FUNCTIONS`
			// (`today` and `now` entries). Discriminator-only; no
			// descendant slots to walk.
			return expr;
		case "date-add":
			// CCHQ value function registered on
			// `commcare-hq/corehq/apps/case_search/xpath_functions/__init__.py::XPATH_VALUE_FUNCTIONS`
			// (`date-add` entry). Recurse into operand slots so a nested
			// non-grammar shape (e.g. `arith` inside `quantity`) lifts.
			return {
				kind: "date-add",
				date: walkValueExpression(expr.date, state, "value"),
				interval: expr.interval,
				quantity: walkValueExpression(expr.quantity, state, "value"),
			};
		case "date-coerce":
			// AST's `date-coerce(value)` maps to CSQL's `date(value)`
			// value function registered on
			// `commcare-hq/corehq/apps/case_search/xpath_functions/__init__.py::XPATH_VALUE_FUNCTIONS`
			// (the `date` entry). The emitter performs the name rename; the
			// hoist walks recursively so any nested non-grammar shape lifts.
			return {
				kind: "date-coerce",
				value: walkValueExpression(expr.value, state, "value"),
			};
		case "datetime-coerce":
			// AST's `datetime-coerce(value)` maps to CSQL's
			// `datetime(value)` value function registered on
			// `commcare-hq/corehq/apps/case_search/xpath_functions/__init__.py::XPATH_VALUE_FUNCTIONS`
			// (the `datetime` entry).
			return {
				kind: "datetime-coerce",
				value: walkValueExpression(expr.value, state, "value"),
			};
		case "double":
			return {
				kind: "double",
				value: walkValueExpression(expr.value, state, "value"),
			};
		case "unwrap-list":
			return {
				kind: "unwrap-list",
				value: walkValueExpression(expr.value, state, "value"),
			};
		case "format-date":
			// `format-date` is absent from CSQL's value-function
			// whitelist on
			// `commcare-hq/corehq/apps/case_search/xpath_functions/__init__.py::XPATH_VALUE_FUNCTIONS`.
			// On-device XPath has `format-date` available via JavaRosa,
			// so the entire expression lifts as a wrapper that runs at
			// runtime and produces the formatted string injected into
			// the CSQL fragment via the synthetic search-input ref.
			return liftAsWrapper(expr, state);
		case "arith":
		case "concat":
		case "coalesce":
		case "if":
		case "switch":
			// Absent from CSQL's whitelists on
			// `commcare-hq/corehq/apps/case_search/xpath_functions/__init__.py::XPATH_VALUE_FUNCTIONS`
			// and `__init__.py::XPATH_QUERY_FUNCTIONS`.
			// Lift the entire expression as a wrapper that runs on-device
			// and produces the resolved value string at evaluation time.
			return liftAsWrapper(expr, state);
		case "count":
			return walkCount(expr, state, position);
		default: {
			const _exhaustive: never = expr;
			throw new Error(
				`csqlHoist: unhandled value expression kind ${String(_exhaustive)}`,
			);
		}
	}
}

/**
 * Count's lift-vs-leave decision is the one place position context
 * fully determines the outcome:
 *
 *   - In `comparison-operand` position with `via.kind === "subcase"`:
 *     CCHQ's `_is_subcase_count` recogniser nested inside
 *     `commcare-hq/corehq/apps/case_search/filter_dsl.py::build_filter_from_ast`
 *     reaches the comparison's LHS to detect `subcase-count` as a
 *     native CSQL function. Survive unmodified; the optional
 *     `where` clause walks normally so any nested non-grammar
 *     descendant lifts.
 *   - In any other position (including `comparison-operand` with
 *     non-subcase direction): lift the entire `count(...)` as a
 *     wrapper expression. The on-device wrapper computes the
 *     cardinality and the wire layer injects the resulting numeric
 *     literal into the CSQL fragment at the appropriate
 *     concat-segment position.
 */
function walkCount(
	expr: Extract<ValueExpression, { kind: "count" }>,
	state: HoistState,
	position: HoistPosition,
): ValueExpression {
	if (position === "comparison-operand" && expr.via.kind === "subcase") {
		const where =
			expr.where !== undefined ? walkPredicate(expr.where, state) : undefined;
		if (where === undefined) {
			return { kind: "count", via: expr.via };
		}
		return { kind: "count", via: expr.via, where };
	}
	return liftAsWrapper(expr, state);
}

/**
 * Lift a value expression into a synthetic search-input ref and
 * record the wrapper. The synthetic input ref is a structural
 * `term`-arm ValueExpression so the inner CSQL emitter can
 * interpolate the runtime-built string at the same code path it uses
 * for author-written input refs.
 *
 * Naming is deterministic from the walker's `nextIndex` counter,
 * giving stable test fixtures and stable round-trip shape. The
 * counter is seeded by `seedNextIndex` past any author-written
 * `csql_hoist_<n>` reference so synthetic names never shadow author
 * refs.
 */
function liftAsWrapper(
	expr: ValueExpression,
	state: HoistState,
): ValueExpression {
	const syntheticName = `${HOIST_INPUT_NAME_PREFIX}${state.nextIndex}`;
	state.nextIndex += 1;
	state.wrappers.push({ inputRef: syntheticName, expression: expr });
	const ref: SearchInputRef = { kind: "input", name: syntheticName };
	return { kind: "term", term: ref };
}
