// lib/commcare/predicate/csqlHoist.ts
//
// AST → AST transformation that lifts every value expression CSQL cannot
// represent inline out of a Predicate, replacing each lifted node with a
// synthetic search-input reference and recording the original
// `ValueExpression` as a wrapper that the on-device XPath builds before
// the CSQL fragment is interpolated.
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
// surface; whatever the AST contains, the hoist + emit pipeline
// produces faithful CSQL output.
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
 * Top-level entry point. Walks the predicate, lifts non-grammar
 * value expressions into synthetic input refs, and returns the
 * rewritten AST plus the wrapper list. `when-input-present`
 * predicates pass through unchanged (the emitter handles them via
 * recursive CSQL emission and the canonical
 * `if(count(<trigger>), <inner-csql>, 'match-all()')` wrapper).
 *
 * Before walking, `seedNextIndex` scans the input for author-written
 * `csql_hoist_<n>` references and starts the synthetic counter past
 * the highest one found. The seed-and-scan keeps synthetic refs
 * distinct from author refs even when authors deliberately use the
 * prefix.
 *
 * The input predicate is never mutated. The wrapper list preserves
 * the order lifted nodes were encountered during the walk, so naming
 * is deterministic for testability.
 */
export function hoistForCsql(predicate: Predicate): CsqlHoistResult {
	const state: HoistState = {
		nextIndex: seedNextIndex(predicate),
		wrappers: [],
	};
	const hoisted = walkPredicate(predicate, state);
	return {
		hoisted,
		wrappers: state.wrappers,
	};
}

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
 * pattern at `case_search_query_language.rst:299-303` where a
 * `subcase-exists("parent", ... clinic_case_id = "', instance(...),
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
