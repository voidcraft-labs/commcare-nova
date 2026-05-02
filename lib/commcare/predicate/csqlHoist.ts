// lib/commcare/predicate/csqlHoist.ts
//
// AST → AST transformation that lifts every value expression CSQL cannot
// represent inline out of a Predicate, replacing each lifted node with a
// synthetic search-input reference and recording the original
// `ValueExpression` as a wrapper that the on-device XPath builds before
// the CSQL fragment is interpolated.
//
// CSQL's two function whitelists at
// `commcare-hq/corehq/apps/case_search/xpath_functions/__init__.py:27-54`
// register the inner CSQL fragment's vocabulary: 8 value functions
// (lines 27-36: `date`, `date-add`, `datetime`, `datetime-add`,
// `double`, `now`, `today`, `unwrap-list`) plus 14 query functions
// (lines 39-54). Every other shape — conditionals (`if`, `switch`),
// arithmetic (`arith`), string concatenation (`concat`, `coalesce`),
// `count(...)` outside the comparison-LHS slot CCHQ recognises as
// `subcase-count` — lifts into an on-device wrapper expression that
// runs at runtime and produces a string injected into the CSQL
// fragment via a synthetic search-input ref.
//
// The pattern follows CCHQ's canonical example at
// `commcare-hq/docs/case_search_query_language.rst:299-303` and
// `:403-407`: an outer XPath `concat(...)` builds the CSQL string
// from constant fragments and runtime-resolved instance reads. The
// hoist pass generalises that pattern to every non-grammar shape.
//
// The pass is total: every input AST produces a CSQL-emission-
// compatible output AST plus a wrapper list. There is no error
// surface; whatever the AST contains, the hoist + emit pipeline
// produces faithful CSQL output.
//
// `when-input-present(trigger, clause)` is preserved through the
// hoist pass; the emitter handles it directly by emitting the
// canonical CCHQ pattern at
// `commcare-hq/docs/case_search_query_language.rst:299-303`:
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
// lifts as a wrapper expression. Plan 4's wire emission evaluates
// the count on-device and injects the resolved number into the CSQL
// fragment via the synthetic search-input ref.
//
// The pass is pure: the input AST is never mutated, every transformed
// node is a fresh object literal, and the wrapper list is returned
// alongside the rewritten predicate.

import type {
	Predicate,
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
 *     `_is_subcase_count` recogniser at
 *     `commcare-hq/corehq/apps/case_search/filter_dsl.py:80-86`. Other
 *     count shapes still lift into the wrapper.
 *   - `value` — every other ValueExpression slot. All count shapes
 *     lift; grammar value functions survive intact.
 */
type HoistPosition = "comparison-operand" | "value";

/**
 * A single lifted value expression. `inputName` is the synthetic
 * search-input ref name that replaces the lifted node in the
 * transformed AST; `expression` is the original ValueExpression that
 * runs on-device before CSQL emission and produces the runtime
 * string interpolated into the CSQL fragment.
 *
 * Plan 4's wire layer emits one `<data>` element per wrapper before
 * the CSQL data element so the wrapper inputs resolve before the
 * CSQL fragment does. The CSQL fragment references the synthetic
 * name via the standard search-input wire path
 * (`instance('search-input:results')/input/field[@name='<name>']`),
 * so downstream evaluation reads the runtime-built string in place of
 * the lifted expression.
 */
export interface HoistedWrapper {
	readonly inputName: string;
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
 * Top-level entry point. Walks the predicate, lifts non-grammar
 * value expressions into synthetic input refs, and returns the
 * rewritten AST plus the wrapper list. `when-input-present`
 * predicates pass through unchanged (the emitter handles them via
 * recursive CSQL emission and the canonical
 * `if(count(<trigger>), <inner-csql>, 'match-all()')` wrapper).
 *
 * The input predicate is never mutated; every transformed node is a
 * fresh object. The wrapper list preserves the order lifted nodes
 * were encountered during the walk, which gives deterministic naming
 * for testability — `csql_hoist_0`, `csql_hoist_1`, etc.
 */
export function hoistForCsql(predicate: Predicate): CsqlHoistResult {
	const state: HoistState = {
		nextIndex: 0,
		wrappers: [],
	};
	const hoisted = walkPredicate(predicate, state);
	return {
		hoisted,
		wrappers: state.wrappers,
	};
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
 * pattern at `case_search_query_language.rst:299-303` where a
 * `subcase-exists("parent", ... clinic_case_id = "', instance(...),
 * '")')` interpolates a runtime user clinic id into the inner CSQL.
 *
 * Every returned predicate is a fresh allocation regardless of
 * whether anything was hoisted, keeping the caller's contract
 * uniform.
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
			// leaves them unchanged.
			return p;
		case "is-null":
		case "is-blank":
			return {
				kind: p.kind,
				left: walkValueExpression(p.left, state, "value"),
			};
		case "between": {
			// Between's bounds are optional; the absent-not-undefined
			// contract from the schema layer requires the rebuilt object
			// to omit absent bound keys rather than materialise them as
			// `undefined`. Rebuild conditionally to preserve that shape.
			const left = walkValueExpression(p.left, state, "value");
			const lower =
				p.lower !== undefined
					? walkValueExpression(p.lower, state, "value")
					: undefined;
			const upper =
				p.upper !== undefined
					? walkValueExpression(p.upper, state, "value")
					: undefined;
			if (lower !== undefined && upper !== undefined) {
				return {
					kind: "between",
					left,
					lower,
					upper,
					lowerInclusive: p.lowerInclusive,
					upperInclusive: p.upperInclusive,
				};
			}
			if (lower !== undefined) {
				return {
					kind: "between",
					left,
					lower,
					lowerInclusive: p.lowerInclusive,
					upperInclusive: p.upperInclusive,
				};
			}
			if (upper !== undefined) {
				return {
					kind: "between",
					left,
					upper,
					lowerInclusive: p.lowerInclusive,
					upperInclusive: p.upperInclusive,
				};
			}
			return {
				kind: "between",
				left,
				lowerInclusive: p.lowerInclusive,
				upperInclusive: p.upperInclusive,
			};
		}
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
			// `commcare-hq/docs/case_search_query_language.rst:299-303`.
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
	}
}

/**
 * Recursive walker over the value-expression union. Decides per-arm
 * whether to (a) leave the node intact (CSQL grammar arm) or (b) lift
 * it as a wrapper expression.
 *
 * CSQL's value-function whitelist at
 * `commcare-hq/corehq/apps/case_search/xpath_functions/__init__.py:27-36`
 * registers exactly eight value functions: `date`, `date-add`,
 * `datetime`, `datetime-add`, `double`, `now`, `today`, `unwrap-list`.
 * Plus terms (which are not function calls). Every other arm lifts.
 */
function walkValueExpression(
	expr: ValueExpression,
	state: HoistState,
	position: HoistPosition,
): ValueExpression {
	switch (expr.kind) {
		case "term":
			// Terms carry no recursive ValueExpression slot; the schema's
			// term union is flat. Pass through unchanged.
			return expr;
		case "today":
		case "now":
			// CCHQ value functions at
			// `commcare-hq/corehq/apps/case_search/xpath_functions/__init__.py:33-34`.
			return expr;
		case "date-add":
			// CCHQ value function at
			// `commcare-hq/corehq/apps/case_search/xpath_functions/__init__.py:29`.
			// Recurse into operand slots so a nested non-grammar shape
			// (e.g. `arith` inside `quantity`) lifts.
			return {
				kind: "date-add",
				date: walkValueExpression(expr.date, state, "value"),
				interval: expr.interval,
				quantity: walkValueExpression(expr.quantity, state, "value"),
			};
		case "date-coerce":
			return {
				kind: "date-coerce",
				value: walkValueExpression(expr.value, state, "value"),
			};
		case "datetime-coerce":
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
			return {
				kind: "format-date",
				date: walkValueExpression(expr.date, state, "value"),
				pattern: expr.pattern,
			};
		case "arith":
		case "concat":
		case "coalesce":
		case "if":
		case "switch":
			// Absent from CSQL's whitelists at
			// `commcare-hq/corehq/apps/case_search/xpath_functions/__init__.py:27-54`.
			// Lift the entire expression as a wrapper that runs on-device
			// and produces the resolved value string at evaluation time.
			return liftAsWrapper(expr, state);
		case "count":
			return walkCount(expr, state, position);
	}
}

/**
 * Count's lift-vs-leave decision is the one place position context
 * fully determines the outcome:
 *
 *   - In `comparison-operand` position with `via.kind === "subcase"`:
 *     CCHQ's `_is_subcase_count` recogniser at
 *     `commcare-hq/corehq/apps/case_search/filter_dsl.py:80-86`
 *     reaches the comparison's LHS to detect `subcase-count` as a
 *     native CSQL function. Survive unmodified; the optional
 *     `where` clause walks normally so any nested non-grammar
 *     descendant lifts.
 *   - In any other position (including `comparison-operand` with
 *     non-subcase direction): lift the entire `count(...)` as a
 *     wrapper expression. The on-device wrapper computes the
 *     cardinality and Plan 4's wire layer injects the resulting
 *     numeric literal into the CSQL fragment at the appropriate
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
 * giving stable test fixtures and stable round-trip shape.
 */
function liftAsWrapper(
	expr: ValueExpression,
	state: HoistState,
): ValueExpression {
	const inputName = `${HOIST_INPUT_NAME_PREFIX}${state.nextIndex}`;
	state.nextIndex += 1;
	state.wrappers.push({ inputName, expression: expr });
	const inputRef: SearchInputRef = { kind: "input", name: inputName };
	return { kind: "term", term: inputRef };
}
