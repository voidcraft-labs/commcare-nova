// lib/case-store/sql/compilePredicate.ts
//
// Compile a `Predicate` AST node to a Kysely boolean expression.
// The case-list query layer feeds the result into a `where(...)`
// clause; the predicate compiler returns an `Expression<SqlBool>`
// — Kysely's typed `where(...)` accepts any expression of that
// shape, and every concrete return shape from the typed builder
// (`ExpressionWrapper`, `RawBuilder`, `SelectQueryBuilder`)
// implements the `Expression<T>` interface uniformly.
//
// ## What this module owns
//
// Per-arm dispatch for every kind in the `Predicate` discriminated
// union — sentinels, logical, comparison, membership, range,
// multi-select containment, text match (four modes), geo,
// relational, conditional, and the null / blank operators. Term
// emission delegates to `./compileTerm`; relation-path subqueries
// delegate to `./compileRelationPath`. The seven `ValueExpression`
// operand slots — `comparison.left` / `.right`, `in.left`,
// `between.left` / `.lower` / `.upper`, `is-null.left`,
// `is-blank.left`, and `within-distance.center` — dispatch through
// `compileValueExprOperand` (term arm → `compileTerm`; every
// other arm → `compileExpression` with a thunk-wired predicate
// callback so the sibling expression compiler's
// `if.cond` / `count.where` arms recurse back through this
// module). The cycle break is the runtime callback; neither
// compiler imports the other through a value-position edge.
//
// ## Tenant scoping
//
// The predicate compiler does NOT emit a tenant filter
// (`(app_id = $1 AND owner_id = $2)`) on the outer query. That
// responsibility belongs to the caller that emits the
// `selectFrom('cases as c')` and threads `where('c.app_id', '=',
// appId).where('c.owner_id', ...)` next to the predicate. The
// compiled predicate composes cleanly with whatever tenant filter
// the wider query layer applies — this module trusts the caller has
// applied it. (Identical contract to `compileTerm`; the relation-
// path compiler enforces tenant scope on every joined `cases` row
// inside its own subquery, so a relation-walk arm carries its own
// tenant defense, but the outer-query filter is still the caller's
// concern.)
//
// ## Postgres-strict null semantics
//
// `is-null` and `is-blank` distinguish three states at the data-
// model layer:
//
//   - "key absent in JSONB document"
//   - "key present with JSON null"
//   - "key present with empty string"
//
// `is-null` matches strict-absent only; `is-blank` widens to
// absent-or-empty. CCHQ's wire layer collapses all three states
// into one match set (a CCHQ accumulation), but Postgres
// distinguishes them natively via `properties ? 'key'` (key
// existence) and `properties->>'key' IS NULL` / `= ''` (value
// shape). The strict semantic is the AST's contract; this compiler
// emits the strict SQL and round-trip tests pin the four distinct
// cases (`is-null` matches absent only, `is-blank` matches absent
// or empty, `compare(prop, "")` matches strictly empty, and
// `compare(prop, null)` matches strictly null).
//
// ## Relation-path strategy: correlated EXISTS, not side-channel
//
// `exists` and `missing` compile to correlated `EXISTS (subquery)`
// / `NOT EXISTS (subquery)` against the relation-path leaf. The
// correlation is the leaf's `anchor_case_id = <ctx.anchorAlias>.case_id`
// equality — same correlation column the term compiler reads
// through. This shape avoids threading a "joins to register" return
// channel through the predicate context: the compiled predicate is
// a single self-contained boolean expression the wider query drops
// into its `where(...)` clause directly.
//
// When the inner `where` of `exists` / `missing` reads a property
// without a `via` (e.g. `eq(prop("household", "size"), literal(5))`
// inside `exists(ancestorPath(...), ...)`), the term compiler
// reads through `ctx.anchorAlias` — so the inner `where`'s ctx
// swaps `anchorAlias` to the relation-path leaf alias for the
// recursive call. The leaf alias is in scope inside the EXISTS
// subquery; the outer anchor remains correlatable too (Postgres
// allows inner queries to reference outer columns), but a self-
// via term inside `where` semantically means "on the related
// case", not "on the anchor", and the alias swap pins that intent.
//
// `via.kind === "self"` collapses to a no-op: `exists(self, where)`
// reduces to `where`, `exists(self)` to `lit(true)`,
// `missing(self, where)` to `not(where)`, and `missing(self)` to
// `lit(false)`. Wrapping a self-via in EXISTS would correlate the
// anchor row against itself and execute one redundant scan per
// row.
//
// ## Nested non-self relation walks compose via depth-suffixed leaf aliases
//
// When the inner `where` of an outer `exists`/`missing` itself
// contains another non-self relation walk — either a nested
// `exists`/`missing` or a property read with a non-self `via` —
// the inner `compileRelationPath` invocation produces its own
// `(SELECT ... FROM case_indices ...) AS <leafAlias>` block.
// SQL's scoping rule isolates each block's hop aliases (`ci0` /
// `cs0` / ...) from the surrounding query, so those identifiers
// never collide across nesting levels.
//
// The leaf alias is a different concern. When the inner WHERE
// references the outer leaf (the correlated-EXISTS body
// correlating against `<outer-leaf>.case_id`, or the inner
// non-self via prop's correlated scalar subquery doing the
// same), Postgres binds an unqualified leaf reference to the
// innermost FROM list — so an inner subquery aliased the same
// `rp_leaf` would shadow the outer one and the correlation
// predicate `<outer-leaf>.case_id = <outer-leaf>.<col>` would
// collapse into self-equality on the inner row.
//
// `compileExistsOrMissing` defends against this by incrementing
// `RelationPathCompileContext.relationPathDepth` before recursing
// into the inner `where`. `compileRelationPath` reads the depth
// to pick `leafAliasForDepth(depth)` — `rp_leaf` at depth 0,
// `rp_leaf_<N>` at deeper nestings — so the inner block's leaf
// alias never matches the outer one and the inner correlation
// reference resolves unambiguously against the outer leaf.
// `compileTerm`'s non-self via reads inherit the same depth via
// the shared context, so their correlated scalar subqueries
// participate in the same uniquification scheme.

import type {
	AliasableExpression,
	AliasedExpression,
	ComparisonOperator,
	Expression,
	SqlBool,
} from "kysely";
import { expressionBuilder } from "kysely";
import {
	compilerBugMessage,
	typeCheckerBypassMessage,
	unhandledKindMessage,
} from "@/lib/domain/predicate/errors";
import type {
	ComparisonKind,
	DistanceUnit,
	MultiSelectQuantifier,
	Predicate,
	PropertyRef,
	Term,
	ValueExpression,
} from "@/lib/domain/predicate/types";
import {
	type CompilePredicateThunk,
	compileExpression,
	type ExpressionCompileContext,
} from "./compileExpression";
import { compileLiteral } from "./compileLiteral";
import { compileRelationPath } from "./compileRelationPath";
import { compileTerm, type TermCompileContext } from "./compileTerm";
import type { Database } from "./database";

// ---------------------------------------------------------------
// Shared expression builder
// ---------------------------------------------------------------

/**
 * The standalone expression builder bound to the case-store
 * `Database` type. Mirrors the shape used in `compileTerm` and
 * `compileExpression` so the three compilers share one entry
 * point into Kysely's typed-builder surface for `eb.lit`,
 * `eb.val`, `eb.cast`, `eb(left, op, right)`, `eb.and`,
 * `eb.or`, `eb.not`, `eb.exists`, `eb.fn`, `eb.ref`, and
 * `eb.selectFrom` calls.
 */
const eb = expressionBuilder<Database, keyof Database>();

// ---------------------------------------------------------------
// Public types
// ---------------------------------------------------------------

/**
 * The compile context every `compilePredicate` call requires.
 *
 * Identical shape to `TermCompileContext`: the predicate compiler
 * threads the same context through to every nested `compileTerm`
 * and `compileRelationPath` call, and the relational quantifier
 * arm (`exists` / `missing`) swaps the `anchorAlias` to the leaf
 * alias when recursing into an inner `where` predicate. No extra
 * fields: the EXISTS-based join strategy (see file header) means
 * there's no "joins to register" channel to thread through the
 * context.
 */
export type PredicateCompileContext = TermCompileContext;

// ---------------------------------------------------------------
// Reserved scalar columns mirror — same set the term compiler keys
// scalar-column dispatch on. Predicate-arm helpers that need to
// distinguish "JSONB-document property" from "scalar column" read
// from this set; co-locating it with the logic that uses it (rather
// than re-exporting from compileTerm) avoids cross-module coupling
// on a closed enum.
// ---------------------------------------------------------------

const RESERVED_SCALAR_COLUMNS: ReadonlySet<string> = new Set([
	"case_id",
	"case_type",
	"owner_id",
	"status",
]);

// ---------------------------------------------------------------
// Comparison operator → SQL token table
// ---------------------------------------------------------------

/**
 * Mapping from `ComparisonKind` to its Postgres SQL operator
 * token. Six operators share the `<left> <op> <right>` shape, so
 * the dispatcher reads from this table rather than restating six
 * near-identical cases. The `Record<ComparisonKind, string>` type
 * pins the table exhaustive against the union — extending
 * `ComparisonKind` surfaces here as a compile-time error.
 *
 * `=` / `!=` are SQL's standard equality / inequality operators;
 * `<>` is also valid SQL inequality but `!=` is what Postgres's
 * default formatter emits and what every other Nova SQL surface
 * uses — keep them aligned.
 */
const COMPARISON_OPS: Record<ComparisonKind, ComparisonOperator> = {
	eq: "=",
	neq: "!=",
	gt: ">",
	gte: ">=",
	lt: "<",
	lte: "<=",
};

// ---------------------------------------------------------------
// Distance-unit → meters conversion
// ---------------------------------------------------------------

/**
 * Conversion factor from each `DistanceUnit` to meters. PostGIS's
 * `ST_DWithin(geography, geography, distance_in_meters)` takes
 * meters as its third argument; the predicate compiler translates
 * the AST's authoring-friendly `(distance, unit)` pair to that
 * scalar at compile time.
 *
 * The miles-to-meters factor `1609.344` is the international mile
 * (NIST handbook 44, the definition every modern jurisdiction
 * shares since 1959). Kilometers → meters is unambiguous SI.
 *
 * Adding a new unit (e.g. `nauticalmiles` to align with CCHQ's
 * wider unit vocabulary) requires extending `DistanceUnit` in
 * `lib/domain/predicate/types.ts` and adding the factor here; the
 * exhaustive dispatch in `compileWithinDistance` surfaces the
 * missing factor at compile time.
 */
const METERS_PER_UNIT: Record<DistanceUnit, number> = {
	miles: 1609.344,
	kilometers: 1000,
};

// ---------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------

/**
 * Compile a `Predicate` AST node to a Kysely boolean expression.
 * The result threads directly into a wider query's `where(...)`
 * clause.
 *
 * Per-arm dispatch:
 *
 *   - **Sentinels** (`match-all`, `match-none`) → `true` / `false`
 *     SQL literals.
 *   - **Logical** (`and`, `or`, `not`) → recursive descent with
 *     paren-wrapped composition.
 *   - **Comparison** (six ops) → `<term> <op> <term>` with the SQL
 *     operator picked from `COMPARISON_OPS`.
 *   - **`in`** → `<term> IN (<value>, <value>, ...)` with literal values
 *     bound as parameters.
 *   - **`between`** → `(<term> >=/> <lower>) AND (<term> <=/< <upper>)`
 *     with the `*Inclusive` flags driving the operator choice.
 *   - **`multi-select-contains`** → JSONB `?|` (any) / `?&` (all)
 *     against the property's JSONB array.
 *   - **`match`** → per-mode dispatch: `LIKE` for `starts-with`,
 *     pg_trgm `%` for `fuzzy`, fuzzystrmatch `dmetaphone(...)`
 *     equality for `phonetic`, digit-permutation `IN (...)` for
 *     `fuzzy-date`.
 *   - **`within-distance`** → PostGIS `ST_DWithin` with
 *     `ST_MakePoint(lon, lat)::geography` on both sides and the
 *     unit-converted radius in meters.
 *   - **`exists` / `missing`** → correlated `EXISTS (subquery)` /
 *     `NOT EXISTS (subquery)` against the relation-path leaf.
 *     `via.kind === "self"` collapses to the inner `where` (or
 *     to the trivially-true / trivially-false sentinel when no
 *     `where` is present).
 *   - **`when-input-present`** → compile-time short-circuit: the
 *     predicate compiles to its `clause` when the named search
 *     input is bound, or to `lit(true)` when the binding is
 *     absent. Runtime-driven semantics (where the input value is
 *     unknown until query time) aren't reachable on the Postgres
 *     pipeline because `ctx.bindings.searchInputs` is resolved
 *     before the compile.
 *   - **`is-null`** → strict-absent: `(NOT (properties ? '<key>'))`
 *     for property refs, `<term> IS NULL` for non-prop terms.
 *   - **`is-blank`** → absent-or-empty: the `is-null` SQL OR'd with
 *     `(properties->>'<key>') = ''` for property refs;
 *     `<term> IS NULL OR <term> = ''` for non-prop terms.
 *
 * The return type is `Expression<SqlBool>` — Kysely's typed
 * boolean-expression contract. Every concrete return shape
 * (`ExpressionWrapper`, `RawBuilder`, `SelectQueryBuilder`)
 * implements it, so consumers thread the result into
 * `where(...)` directly. Tests compile through `.compile()` on
 * the wrapping query.
 */
export function compilePredicate(
	pred: Predicate,
	ctx: PredicateCompileContext,
): Expression<SqlBool> {
	switch (pred.kind) {
		case "match-all":
			// Boolean-algebra identity element. `eb.lit(true)` emits
			// the SQL `true` keyword (not a parameter); binding
			// `true` as a parameter would inflate the parameter list
			// without any expressivity gain.
			return eb.lit(true) as Expression<SqlBool>;
		case "match-none":
			// Boolean-algebra absorbing element. Mirrors the
			// `match-all` rationale via `eb.lit(false)`.
			return eb.lit(false) as Expression<SqlBool>;
		case "and":
			return compileAnd(pred, ctx);
		case "or":
			return compileOr(pred, ctx);
		case "not":
			return compileNot(pred, ctx);
		case "eq":
		case "neq":
		case "gt":
		case "gte":
		case "lt":
		case "lte":
			return compileComparison(pred, ctx);
		case "in":
			return compileIn(pred, ctx);
		case "between":
			return compileBetween(pred, ctx);
		case "multi-select-contains":
			return compileMultiSelectContains(pred, ctx);
		case "match":
			return compileMatch(pred, ctx);
		case "within-distance":
			return compileWithinDistance(pred, ctx);
		case "exists":
			return compileExistsOrMissing(pred, ctx, "exists");
		case "missing":
			return compileExistsOrMissing(pred, ctx, "missing");
		case "when-input-present":
			return compileWhenInputPresent(pred, ctx);
		case "is-null":
			return compileAbsenceCheck(pred.left, ctx, "is-null");
		case "is-blank":
			return compileAbsenceCheck(pred.left, ctx, "is-blank");
		default: {
			const _exhaustive: never = pred;
			throw new Error(
				unhandledKindMessage({
					where: "compilePredicate",
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
						"exists",
						"missing",
						"when-input-present",
						"is-null",
						"is-blank",
					],
				}),
			);
		}
	}
}

// ---------------------------------------------------------------
// ValueExpression operand dispatch
// ---------------------------------------------------------------

/**
 * Compile a `ValueExpression` operand to a Kysely expression.
 *
 * Dispatch:
 *
 *   - `term` arm → `compileTerm` (the value-bearing read at every
 *     leaf slot).
 *   - any other arm (`arith`, `if`, `switch`, `count`,
 *     `format-date`, etc.) → `compileExpression` with a
 *     predicate-compiler thunk wired into the
 *     `ExpressionCompileContext` (so the expression compiler's
 *     own predicate-bearing arms — `if.cond`, `count.where` —
 *     recurse back through `compilePredicate`).
 *
 * The Predicate AST keeps `ValueExpression` operands in seven
 * slots: `comparison.left` / `.right`, `in.left`, `between.left`
 * / `.lower` / `.upper`, `is-null.left`, `is-blank.left`, and
 * `within-distance.center`. Every site routes through this
 * helper, so the dispatch logic is single-source — no per-arm
 * inlined `if (kind === "term")` branches scattered across the
 * compiler.
 *
 * The thunk-wired context closes the cycle that would otherwise
 * arise: `compilePredicate` imports `compileExpression` for non-
 * term operand dispatch, and `compileExpression` calls back into
 * `compilePredicate` through the thunk for its own predicate-
 * bearing arms. Each compiler stays single-source for its own AST
 * union; the cycle break is the runtime callback, not an import-
 * graph edge.
 */
function compileValueExprOperand(
	expr: ValueExpression,
	ctx: PredicateCompileContext,
): AliasableExpression<unknown> {
	if (expr.kind === "term") {
		return compileTerm(expr.term, ctx);
	}
	return compileExpression(expr, expressionContextFor(ctx));
}

/**
 * Lift a `PredicateCompileContext` into the
 * `ExpressionCompileContext` shape the expression compiler needs.
 * The lift attaches the predicate-compiler callback so the
 * expression compiler's `if.cond` / `count.where` arms recurse
 * back through `compilePredicate`.
 *
 * Implemented as a separate function (rather than inlined at the
 * one call site above) so the callback wiring is explicit at the
 * boundary between the two compilers — the cycle break and its
 * direction are visible at one named site instead of buried in a
 * spread-and-property literal inside a dispatch helper.
 */
function expressionContextFor(
	ctx: PredicateCompileContext,
): ExpressionCompileContext {
	const compilePredicateThunk: CompilePredicateThunk = (pred, exprCtx) =>
		compilePredicate(pred, exprCtx);
	return { ...ctx, compilePredicate: compilePredicateThunk };
}

// ---------------------------------------------------------------
// Logical operators — `and` / `or` / `not`
// ---------------------------------------------------------------

/**
 * Conjunction: `(c1) AND (c2) AND ... AND (cN)`. `eb.and([...])`
 * paren-wraps each clause and joins them with ` AND ` — the
 * canonical typed shape for a non-empty conjunction. Each clause
 * containing an `or` (or any operator binding looser than `and`)
 * keeps its grouping under the wrapper; without paren-wrapping,
 * Postgres parses `A OR B AND C` as `A OR (B AND C)` because the
 * conjunction binds tighter, and an unwrapped `or`-clause inside
 * an `and` would silently re-associate.
 *
 * `clauses` is non-empty by construction (the schema's tuple-with-
 * rest shape rejects empty `and` lists), so `eb.and([...])` always
 * receives at least one operand.
 */
function compileAnd(
	pred: Extract<Predicate, { kind: "and" }>,
	ctx: PredicateCompileContext,
): Expression<SqlBool> {
	const compiled = pred.clauses.map(
		(c) => compilePredicate(c, ctx) as Expression<SqlBool>,
	);
	return eb.and(compiled);
}

/**
 * Disjunction: `(c1) OR (c2) OR ... OR (cN)`. Same paren-wrapping
 * rationale as `compileAnd` via `eb.or([...])` — each clause
 * defends its own grouping inside the outer disjunction.
 */
function compileOr(
	pred: Extract<Predicate, { kind: "or" }>,
	ctx: PredicateCompileContext,
): Expression<SqlBool> {
	const compiled = pred.clauses.map(
		(c) => compilePredicate(c, ctx) as Expression<SqlBool>,
	);
	return eb.or(compiled);
}

/**
 * Negation: `NOT (clause)`. `eb.not(...)` paren-wraps the inner
 * clause under the outer `NOT` — `NOT A AND B` parses as
 * `(NOT A) AND B` in SQL, so an unwrapped multi-clause inner would
 * silently re-associate.
 *
 * The builder layer collapses double-negation (`not(not(x))` → `x`)
 * at construction time per `lib/domain/predicate/reduction.ts`, so
 * a `not` wrapping a `not` shouldn't reach this branch through the
 * standard authoring path. Defensive emission: if a directly-
 * constructed `{ kind: "not", clause: { kind: "not", ... } }`
 * literal does reach the compiler, the SQL is still correct (the
 * double-not is preserved literally as `NOT (NOT (...))`, which
 * Postgres collapses internally).
 */
function compileNot(
	pred: Extract<Predicate, { kind: "not" }>,
	ctx: PredicateCompileContext,
): Expression<SqlBool> {
	return eb.not(compilePredicate(pred.clause, ctx) as Expression<SqlBool>);
}

// ---------------------------------------------------------------
// Comparison — six operators
// ---------------------------------------------------------------

/**
 * Compile a comparison: `<left> <op> <right>`. Both operands are
 * `ValueExpression`; `compileValueExprOperand` routes the `term`
 * arm through `compileTerm` and every other arm through
 * `compileExpression` (with a thunk-wired predicate callback for
 * the expression compiler's own predicate-bearing arms).
 *
 * The SQL operator is picked from `COMPARISON_OPS`, the closed
 * `Record<ComparisonKind, ComparisonOperator>` declared at the
 * top of the file. The closed-enum lookup pins the operator to a
 * Kysely-typed `ComparisonOperator` value — no caller-supplied
 * string reaches the binary-op slot.
 */
function compileComparison(
	pred: Extract<Predicate, { kind: ComparisonKind }>,
	ctx: PredicateCompileContext,
): Expression<SqlBool> {
	const left = compileValueExprOperand(pred.left, ctx);
	const right = compileValueExprOperand(pred.right, ctx);
	const opToken = COMPARISON_OPS[pred.kind];
	// `eb(left, op, right)` returns a `SqlBool`-typed wrapper for
	// any `ComparisonOperator`-typed `op`. The closed-enum lookup
	// pins `opToken` to a Kysely-recognised comparison operator at
	// compile time.
	return eb(left, opToken, right);
}

// ---------------------------------------------------------------
// `in` — value-equality set membership
// ---------------------------------------------------------------

/**
 * Compile an `in` predicate: `<left> IN (<value>, <value>, ...)`. Each
 * literal value flows through `compileLiteral` for parameter
 * binding — inlining values would be unsafe (no escaping) and
 * shifts plan-cache invariants off-spec.
 *
 * The schema rejects empty `values` lists at parse time
 * (tuple-with-rest), so the `IN (...)` parenthesization is always
 * non-empty here. The `.refine(...)` rule on `inSchema.values`
 * also rejects all-null lists; mixed null + non-null lists are
 * accepted and compile to an `IN (NULL, 'value', ...)` shape.
 * Postgres's `IN` semantics return `NULL` for any row whose `left`
 * is `NULL` (three-valued logic), but the row-level `NULL` is
 * indistinguishable from a non-matching row in a `WHERE` context,
 * so the SQL behaves as authors expect.
 *
 * Postgres docs reference: § 9.24 "Subquery Expressions" —
 * `expression IN (value [, ...])`.
 */
function compileIn(
	pred: Extract<Predicate, { kind: "in" }>,
	ctx: PredicateCompileContext,
): Expression<SqlBool> {
	const left = compileValueExprOperand(pred.left, ctx);
	const compiledValues = pred.values.map((v) => compileLiteral(v));
	// `eb(left, 'in', [...exprs])` accepts an array of value-bearing
	// expressions; each literal compiles through `compileLiteral`
	// which preserves typed casts and emits `eb.lit(null)` for the
	// null literal. Kysely's `in` operator is in
	// `COMPARISON_OPERATORS`, so the binary call returns a `SqlBool`
	// expression directly.
	return eb(left, "in", compiledValues);
}

// ---------------------------------------------------------------
// `between` — bounded interval
// ---------------------------------------------------------------

/**
 * Compile a `between` predicate. The schema admits at-least-one-
 * bound shapes (`.refine(...)` on `betweenSchema` rejects the both-
 * absent form), so this dispatch covers three live cases:
 *
 *   - both bounds present → `(<l> <op> <left>) AND (<left> <op> <u>)`
 *     where the operators come from the inclusivity flags.
 *   - lower-only → the `<left> >=/> <lower>` half.
 *   - upper-only → the `<left> <=/< <upper>` half.
 *
 * The inclusivity flags drive the comparator: `lowerInclusive: true`
 * → `>=`; `false` → `>`; `upperInclusive: true` → `<=`; `false` →
 * `<`. Same convention as the standard mathematical interval
 * notation `[lower, upper]` / `(lower, upper)`.
 *
 * Bound ordering check: when both bounds are literal-typed and
 * `lower > upper`, the predicate is trivially false. The schema
 * does NOT reject this case because bounds may be search-input or
 * session refs whose values aren't known until runtime; detection
 * of the literal-pair impossibility is a type-checker rule.
 * The SQL compiler emits whatever the schema admits.
 */
function compileBetween(
	pred: Extract<Predicate, { kind: "between" }>,
	ctx: PredicateCompileContext,
): Expression<SqlBool> {
	const left = compileValueExprOperand(pred.left, ctx);
	const lowerOp: ComparisonOperator = pred.lowerInclusive ? ">=" : ">";
	const upperOp: ComparisonOperator = pred.upperInclusive ? "<=" : "<";

	if (pred.lower !== undefined && pred.upper !== undefined) {
		const lower = compileValueExprOperand(pred.lower, ctx);
		const upper = compileValueExprOperand(pred.upper, ctx);
		return eb.and([eb(left, lowerOp, lower), eb(left, upperOp, upper)]);
	}
	if (pred.lower !== undefined) {
		const lower = compileValueExprOperand(pred.lower, ctx);
		return eb(left, lowerOp, lower);
	}
	if (pred.upper !== undefined) {
		const upper = compileValueExprOperand(pred.upper, ctx);
		return eb(left, upperOp, upper);
	}
	// Schema's `.refine(...)` rejects this shape at parse; the
	// runtime branch defends against a directly-constructed bypass.
	throw new Error(
		compilerBugMessage({
			where: "compilePredicate.compileBetween",
			invariant:
				"`between` predicate has neither `lower` nor `upper` bound, but at least one is required",
			detail:
				"`predicateSchema.between`'s `.refine(...)` is supposed to reject this shape at parse time. Reaching this throw means the AST was constructed without going through `predicateSchema.parse(...)`, or was mutated after parse to drop both bounds. Use the typed `between(...)` builder, or restore at least one bound on the predicate.",
		}),
	);
}

// ---------------------------------------------------------------
// `multi-select-contains` — JSONB containment quantifiers
// ---------------------------------------------------------------

/**
 * Compile a multi-select containment predicate. The property is
 * declared `multi_select` in the schema, which means the term
 * compiler reads it as JSONB (via `->`) and casts to `::jsonb` —
 * the JSONB-array shape these operators need.
 *
 * Operator dispatch (Postgres docs § 9.16.1 "JSONB Containment and
 * Existence"):
 *
 *   - `?|` (any-key-exists) — JSONB array contains any of the
 *     given strings as elements. Used for `quantifier: "any"`.
 *   - `?&` (all-keys-exist) — JSONB array contains every given
 *     string. Used for `quantifier: "all"`.
 *
 * Both operators take a JSONB on the left and a `text[]` on the
 * right. The schema's `values` slot is non-empty `Literal[]` and
 * the `.refine(...)` rejects all-null lists, so the runtime
 * `text[]` is always non-empty.
 *
 * Token typing: multi-select tokens on CommCare are wire-form
 * strings (the property's stored value is a space-separated string
 * blob; each token is a single label / option-value identifier).
 * The Postgres JSONB key-existence operators (`?|` / `?&`) match
 * by string equality against array elements — the JSONB types of
 * the array elements and the candidate values must agree. Numeric
 * or boolean literals would silently mismatch a JSONB array of
 * strings (and vice versa), so the compiler rejects every
 * non-string token at the SQL boundary with a clear error rather
 * than `String(v)`-coerce and emit a never-matching predicate.
 * Null literals also drop here for the same reason — JSONB
 * key-exists has no NULL semantic.
 *
 * The single-value `any` form could collapse to the `?` operator
 * (key-exists, single string RHS) but the `?|` operator with a
 * one-element array produces the same row set and keeps one code
 * path. Choosing the uniform shape simplifies SQL inspection at
 * the cost of one negligible array allocation per query plan.
 */
function compileMultiSelectContains(
	pred: Extract<Predicate, { kind: "multi-select-contains" }>,
	ctx: PredicateCompileContext,
): Expression<SqlBool> {
	// Property reference is constrained at the schema layer to the
	// direct property-ref shape (no `via`-relational reads). Route
	// through compileTerm to inherit the JSONB read + ::jsonb cast
	// for `multi_select` properties. `pred.property` already carries
	// `kind: "prop"` per `propertyRefSchema`; passing the shape
	// directly avoids TypeScript's spread-overwrite warning.
	const left = compileTerm(pred.property, ctx);

	// Token validation: every literal value in the array must be a
	// string. Null literals drop silently (the all-null defense lives
	// at the schema layer's `.refine(...)`; mixed-with-non-null
	// lists are parse-accepted but the JSONB array-element-typing
	// excludes null). Non-string tokens (numbers, booleans) reject
	// here with a clear error so a `String(v)`-coerced token doesn't
	// silently produce a never-matching predicate against a JSONB
	// array of strings.
	const stringValues: string[] = [];
	for (const v of pred.values) {
		if (v.value === null) {
			continue;
		}
		if (typeof v.value !== "string") {
			throw new Error(
				typeCheckerBypassMessage({
					where: "compilePredicate.compileMultiSelectContains",
					summary:
						"`multi-select-contains` accepts only string-typed token literals",
					expected:
						"every token literal in `values` to have `typeof value === 'string'`",
					received: `a token literal whose runtime type is \`${typeof v.value}\` (value: \`${String(v.value)}\`)`,
					hint: "multi-select tokens are wire-form strings; the JSONB key-existence operators `?|` / `?&` match by string equality only. Cast the literal to a string at the AST authoring site, or correct the AST to use the right token type.",
				}),
			);
		}
		stringValues.push(v.value);
	}

	const operatorToken = quantifierToOperator(pred.quantifier);
	// `eb(left, '?|' | '?&', <text[]>)` — both operators are in
	// `COMPARISON_OPERATORS`, returning `SqlBool`. The `text[]`
	// right operand binds via `eb.val(stringValues)` so pg's
	// driver applies its native array-binding form (not a
	// stringified blob).
	return eb(left, operatorToken, eb.val(stringValues));
}

/**
 * Map a multi-select quantifier to its JSONB containment operator
 * token. Both tokens are in `COMPARISON_OPERATORS` (the typed
 * `eb(left, op, right)` call admits them as `ComparisonOperator`
 * values).
 *
 * Closed enum dispatch — the exhaustive switch over
 * `MultiSelectQuantifier` surfaces any new quantifier surface at
 * compile time, so the operator-table here stays in lockstep with
 * the AST union.
 */
function quantifierToOperator(
	quantifier: MultiSelectQuantifier,
): ComparisonOperator {
	switch (quantifier) {
		case "any":
			return "?|";
		case "all":
			return "?&";
		default: {
			const _exhaustive: never = quantifier;
			throw new Error(
				unhandledKindMessage({
					where: "compilePredicate.quantifierToOperator",
					family: "MultiSelectQuantifier",
					received: _exhaustive,
					knownKinds: ["any", "all"],
				}),
			);
		}
	}
}

// ---------------------------------------------------------------
// `match` — text-match predicates
// ---------------------------------------------------------------

/**
 * Compile a text-match predicate. Each `MatchMode` dispatches to a
 * different Postgres operator / function pair, all reading through
 * a `text`-typed property reference.
 *
 *   - `starts-with` → `<prop>::text LIKE 'value%'` (case-sensitive
 *     prefix). CCHQ's wire form is also case-sensitive (the
 *     `PROPERTY_VALUE_EXACT` index per `case_search.py:312-323`),
 *     so Postgres's `LIKE` (case-sensitive) matches semantics.
 *     Special characters in the value (`%`, `_`, `\`) are escaped
 *     to keep them literal.
 *   - `fuzzy` → pg_trgm `<prop>::text % 'value'`. The `%` operator
 *     is the canonical pg_trgm similarity test and pairs with a
 *     GIN index on `gin_trgm_ops` for fast retrieval. The
 *     similarity threshold is `pg_trgm.similarity_threshold`
 *     (Postgres GUC, default 0.3); authoring time has no per-
 *     predicate threshold knob today.
 *   - `phonetic` → fuzzystrmatch `dmetaphone(<prop>::text) =
 *     dmetaphone('value')`. Double Metaphone is more
 *     discriminating than Soundex and is the recommended
 *     phonetic-match function in modern fuzzystrmatch usage.
 *   - `fuzzy-date` → digit-permutation set match. CCHQ's
 *     `query_functions.py:101-113` calls
 *     `case_property_query(name, date_permutations(value),
 *     boost_first=True)` where `date_permutations` produces the
 *     16 transposed-date variants (year/month/day swaps and
 *     digit reversals); the Postgres translation is `<prop> IN
 *     (perm1, perm2, ...)` over the permutation set.
 *
 * pg_trgm reference: § F.32 "pg_trgm". fuzzystrmatch reference:
 * § F.18 "fuzzystrmatch".
 */
function compileMatch(
	pred: Extract<Predicate, { kind: "match" }>,
	ctx: PredicateCompileContext,
): Expression<SqlBool> {
	const propRead = compilePropertyAsText(pred.property, ctx);

	// `match.value` is a term-arm `ValueExpression` (per the type
	// checker's `checkMatch` rule). Non-term arms are rejected at
	// type-check time; reaching this throw indicates a bypass.
	if (pred.value.kind !== "term") {
		throw new Error(
			typeCheckerBypassMessage({
				where: "compilePredicate.compileMatch",
				summary:
					"`match` requires a term-arm `ValueExpression` for `value`, but received a non-term arm",
				expected:
					"`pred.value.kind === 'term'` (a `Term` lifted via `term(...)`, or a literal / property / input / session reference)",
				received: `\`pred.value.kind === '${pred.value.kind}'\``,
				hint: "see `checkMatch` in `lib/domain/predicate/typeChecker.ts` for the term-arm rule. Wrap the value in `term(...)` if it is a `Term`, or replace the `match` predicate with a different operator that accepts the wider expression family.",
			}),
		);
	}
	// Compile the value term as text. Literal values bind through
	// Kysely's parameter channel; non-literal terms (search-input
	// refs, session refs, property refs) compile through the term
	// compiler and produce typed expressions Postgres consumes
	// directly. The outer `::text` cast lifts whatever type the term
	// resolved to into the text domain pg_trgm / fuzzystrmatch / LIKE
	// all expect.
	const valueRead = eb.cast<string>(compileTerm(pred.value.term, ctx), "text");

	switch (pred.mode) {
		case "starts-with":
			// Postgres `starts_with(string, prefix)` returns boolean
			// directly without LIKE-meta-character escaping concerns
			// (no wildcard semantics on the prefix argument). Works
			// with any text expression; safe for runtime values.
			return eb.fn<boolean>("starts_with", [
				propRead,
				valueRead,
			]) as unknown as Expression<SqlBool>;
		case "fuzzy":
			// pg_trgm `%` operator: returns true if the trigram
			// similarity of the two arguments exceeds
			// `pg_trgm.similarity_threshold` (default 0.3). The `%`
			// operator is in `ARITHMETIC_OPERATORS` (Kysely types
			// arithmetic ops as returning the LHS column type), so
			// the resulting `ExpressionWrapper<DB, TB, T>` carries
			// the LHS string type. The cast at the public boundary
			// pins the boolean shape Postgres actually emits at
			// runtime.
			return eb(propRead, "%", valueRead) as unknown as Expression<SqlBool>;
		case "phonetic":
			// Double Metaphone equality. fuzzystrmatch's `dmetaphone`
			// produces a phonetic key; equality on the keys means
			// the two inputs sound alike.
			return eb(
				eb.fn<string>("dmetaphone", [propRead]),
				"=",
				eb.fn<string>("dmetaphone", [valueRead]),
			);
		case "fuzzy-date":
			// fuzzy-date generates the digit-permutation set from the
			// input value at compile time, which requires the value to
			// be a literal text constant. Dynamic values (search-input
			// refs, session refs, property refs) cannot pre-compute
			// the set and throw with a clear error at the boundary.
			// CCHQ's `date_permutations` algorithm is the reference at
			// `commcare-hq/corehq/apps/case_search/xpath_functions/query_functions.py:101-140`.
			if (
				pred.value.term.kind !== "literal" ||
				typeof pred.value.term.value !== "string"
			) {
				throw new Error(
					[
						"`compilePredicate` — `match` (mode `fuzzy-date`) requires a literal text value on the Postgres runtime path.",
						"",
						`    expected: a \`literal\` term whose \`value\` is a string`,
						`    got:      a \`${pred.value.term.kind}\` term`,
						"",
						"`fuzzy-date` generates the digit-permutation set at compile time, which",
						"requires the input value to be known at compile time. Dynamic values",
						"(search-input refs, session refs, property refs) cannot pre-compute the",
						"set and need a Postgres-side permutation function the runtime does not",
						"yet provide.",
						"",
						"The CSQL and on-device wire emitters accept the dynamic value; only",
						"the Postgres runtime path is constrained.",
						"",
						"Hint: pass a literal `YYYY-MM-DD` string for the value, or use a",
						"different `match` mode (`fuzzy` / `phonetic` / `starts-with`) that",
						"accepts dynamic values.",
					].join("\n"),
				);
			}
			return compileFuzzyDate(propRead, pred.value.term.value);
		default: {
			const _exhaustive: never = pred.mode;
			throw new Error(
				unhandledKindMessage({
					where: "compilePredicate.compileMatch",
					family: "MatchMode",
					received: _exhaustive,
					knownKinds: ["fuzzy", "phonetic", "fuzzy-date", "starts-with"],
				}),
			);
		}
	}
}

/**
 * Compile a property reference for use inside a `match`-mode
 * dispatch. Every match mode reads the property as text — even if
 * the property's declared `data_type` is otherwise (e.g. an `int`
 * property compared via `starts-with` semantically asks "starts
 * with these characters", which is text semantics). The cast lifts
 * the JSONB read to text uniformly across every mode.
 *
 * `via` non-self routes through the relation-path leaf alias —
 * caller is responsible for the join. Same contract as
 * `compileTerm`.
 */
function compilePropertyAsText(
	property: PropertyRef,
	ctx: PredicateCompileContext,
): AliasableExpression<string> {
	// Delegate the JSONB-vs-scalar dispatch and via-routing to
	// compileTerm; wrap the result in `::text` regardless of the
	// underlying data_type cast. The compileTerm output is already
	// a properly-typed expression for the column's `data_type`; the
	// outer `::text` cast lifts whatever shape it produced into the
	// text domain that pg_trgm / fuzzystrmatch / LIKE all expect.
	const propExpr = compileTerm(property, ctx);
	return eb.cast<string>(propExpr, "text");
}

/**
 * Compile a `fuzzy-date` match by generating the digit-permutation
 * set and emitting `prop IN (perm1, perm2, ...)`. The permutation
 * algorithm mirrors CCHQ's `date_permutations(date_str)` at
 * `commcare-hq/corehq/apps/case_search/xpath_functions/query_functions.py:116-140`
 * — sixteen variants from year/month/day swaps and digit
 * reversals, filtered to the structurally-valid date strings.
 *
 * Validation: the input must parse as `YYYY-MM-DD`. CCHQ's
 * `validate_date(value)` uses `datetime.strptime(value, '%Y-%m-%d')`;
 * the JS-side check uses an equivalent regex + month/day range
 * check. A mismatched input throws — the schema's `.min(1)` on
 * `match.value` admits any non-empty string, but the `fuzzy-date`
 * mode demands the YYYY-MM-DD shape because the permutation
 * algorithm splits on `-` and reads three numeric segments.
 */
function compileFuzzyDate(
	propRead: AliasableExpression<unknown>,
	value: string,
): Expression<SqlBool> {
	const permutations = generateDatePermutations(value);
	if (permutations.length === 0) {
		// Defensive: the input passed `match.value`'s `.min(1)` but
		// failed the YYYY-MM-DD shape. Throw a clear error rather
		// than emit `<prop> IN ()` (a Postgres syntax error).
		throw new Error(
			[
				"`compilePredicate` — `match` (mode `fuzzy-date`) requires a `YYYY-MM-DD` value.",
				"",
				`    expected: a string of the form 'YYYY-MM-DD' (zero-padded month and day)`,
				`    got:      '${value}'`,
				"",
				"`fuzzy-date` splits the input on `-` and reads three numeric segments to",
				"generate the digit-permutation set; values that do not match the",
				"`YYYY-MM-DD` shape produce an empty permutation set, which would emit a",
				"Postgres-syntax-invalid `<prop> IN ()`.",
				"",
				"Hint: pass a date string with year-month-day order and zero-padded",
				"segments (e.g. `2024-03-05`), or coerce the input upstream of the AST.",
			].join("\n"),
		);
	}
	// `eb(left, 'in', [...exprs])` — each permutation binds as a
	// parameter via `eb.val`. The permutation set is non-empty by
	// construction (the empty case throws above), so the IN list
	// is always non-empty and Postgres-syntax-valid.
	return eb(
		propRead,
		"in",
		permutations.map((p) => eb.val(p)),
	);
}

/**
 * Generate the digit-permutation set for a `YYYY-MM-DD` date
 * string. Mirrors CCHQ's `date_permutations` at
 * `commcare-hq/corehq/apps/case_search/xpath_functions/query_functions.py:116-140`
 * — sixteen variants from year-decade reversals plus month-string
 * reversals and day-string reversals, filtered to those that
 * structurally parse as a date.
 *
 * Returns `[]` if the input doesn't match the canonical
 * `YYYY-MM-DD` shape; the caller throws on the empty result.
 *
 * The validation side of CCHQ is `datetime.strptime(value,
 * '%Y-%m-%d')`. JS's `Date.parse` is too permissive for parity
 * (it accepts `2026-13-01` and rolls into next year). The regex +
 * range check below matches CCHQ's strict shape.
 */
function generateDatePermutations(value: string): string[] {
	const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
	if (match === null) {
		return [];
	}
	const [, year, month, day] = match;
	if (!isValidDate(year, month, day)) {
		return [];
	}

	// CCHQ's variable shape: `reverse_decade` swaps the third and
	// fourth year digits (`2026` → `2062`); `reverse_month` and
	// `reverse_day` reverse two-digit strings (`12` → `21`,
	// `03` → `30`).
	const reverseDecade = `${year[0]}${year[1]}${year[3]}${year[2]}`;
	const reverseMonth = `${month[1]}${month[0]}`;
	const reverseDay = `${day[1]}${day[0]}`;

	// Sixteen permutations per CCHQ's literal list. The first entry
	// is the original input; CCHQ's `boost_first=True` boosts the
	// exact match's relevance score on ES, but Postgres's `IN`
	// returns a flat boolean — there's no relevance signal to
	// propagate, so the order in the IN list is immaterial to the
	// row set.
	const candidates = [
		value,
		`${year}-${day}-${month}`,
		`${year}-${reverseMonth}-${day}`,
		`${year}-${day}-${reverseMonth}`,
		`${year}-${month}-${reverseDay}`,
		`${year}-${reverseDay}-${month}`,
		`${year}-${reverseMonth}-${reverseDay}`,
		`${year}-${reverseDay}-${reverseMonth}`,
		`${reverseDecade}-${month}-${day}`,
		`${reverseDecade}-${day}-${month}`,
		`${reverseDecade}-${reverseMonth}-${day}`,
		`${reverseDecade}-${day}-${reverseMonth}`,
		`${reverseDecade}-${month}-${reverseDay}`,
		`${reverseDecade}-${reverseDay}-${month}`,
		`${reverseDecade}-${reverseMonth}-${reverseDay}`,
		`${reverseDecade}-${reverseDay}-${reverseMonth}`,
	];

	// CCHQ filters via `[p for p in permutations if validate_date(p)]`
	// — the structural-shape filter that drops e.g. `2026-21-03`
	// (month 21 doesn't exist) before they reach the search query.
	// Same filter here; the `Set` deduplicates the variants that
	// collapse into the same string (e.g. for `2026-12-21`, the
	// `reverse_day` swap produces `2026-12-12`, distinct from the
	// original — but for `2026-11-11` many variants collapse to
	// the same string).
	return Array.from(
		new Set(
			candidates.filter((p) => {
				const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(p);
				return m !== null && isValidDate(m[1], m[2], m[3]);
			}),
		),
	);
}

/**
 * Validate `(year, month, day)` against the calendar-day constraint
 * — month in 1-12, day in 1-(month-length-with-leap-year). Mirrors
 * CCHQ's `datetime.strptime(s, '%Y-%m-%d')` strictness in JS.
 *
 * The leap-year rule (Gregorian: divisible by 4 but not 100, or
 * divisible by 400) handles the February-29 edge case correctly
 * over every year in a four-digit YYYY range.
 */
function isValidDate(year: string, month: string, day: string): boolean {
	const y = Number(year);
	const m = Number(month);
	const d = Number(day);
	if (m < 1 || m > 12 || d < 1) return false;
	const isLeap = (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
	const monthLengths = [
		31,
		isLeap ? 29 : 28,
		31,
		30,
		31,
		30,
		31,
		31,
		30,
		31,
		30,
		31,
	];
	return d <= monthLengths[m - 1];
}

// ---------------------------------------------------------------
// `within-distance` — PostGIS geographic predicate
// ---------------------------------------------------------------

/**
 * Compile a `within-distance` predicate. The geopoint property's
 * stored value is the CommCare wire form
 * `"latitude longitude altitude accuracy"` (four space-separated
 * decimals; the geopoint pattern is pinned by `GEOPOINT_PATTERN`
 * in `lib/domain/predicate/jsonSchema.ts`); the property reads as
 * text, the lat/lon parse out via `split_part`, and the predicate
 * builds two `geography`-typed points to feed `ST_DWithin`.
 *
 * Postgres / PostGIS reference: PostGIS docs § "ST_DWithin" —
 * `ST_DWithin(geography, geography, distance_in_meters)`. The
 * `geography` cast (rather than `geometry`) interprets the
 * coordinates as lat/lon on the WGS-84 ellipsoid, which is what
 * the stored geopoint format encodes; `geometry` would treat the
 * coordinates as planar units and produce wrong distances at any
 * non-equatorial latitude.
 *
 * `ST_MakePoint(longitude, latitude)` is intentional: PostGIS's
 * `ST_MakePoint` takes its arguments in `(x, y)` = `(lon, lat)`
 * order, the GIS standard, **the opposite of the geopoint wire
 * form's stored order**. The `split_part` calls below pull
 * `lat = split_part(prop, ' ', 1)` and `lon = split_part(prop, ' ', 2)`,
 * then feed `(lon, lat)` to `ST_MakePoint`.
 *
 * Distance unit conversion: the AST stores `(distance, unit)`;
 * `METERS_PER_UNIT` converts to meters at compile time, and
 * `ST_DWithin` consumes meters directly.
 *
 * Center handling: `pred.center` is a `ValueExpression`. The
 * `compileValueExprOperand` helper dispatches the operand — `term`
 * arms route through `compileTerm` (a `prop` / `input` /
 * `session-user` / `session-context` / `literal` reading the same
 * wire-form geopoint string), and every other arm routes through
 * `compileExpression` (an `if` selecting between two literal
 * geopoints, a `coalesce` chain, a `concat` building the wire
 * string from parts). The result composes the same `(centerLat,
 * centerLon)` split shape downstream regardless of which arm
 * supplied the wire-form text.
 */
function compileWithinDistance(
	pred: Extract<Predicate, { kind: "within-distance" }>,
	ctx: PredicateCompileContext,
): Expression<SqlBool> {
	// Property side: read the geopoint string as text, then split
	// out lat/lon via split_part. compileTerm reads `geopoint` as
	// text per `POSTGRES_CAST_FOR_DATA_TYPE`, so the outer `::text`
	// cast is structurally redundant but documents the type at the
	// split site.
	const propText = eb.cast<string>(compileTerm(pred.property, ctx), "text");
	const propLat = splitNumericComponent(propText, 1);
	const propLon = splitNumericComponent(propText, 2);

	// Center side: same split shape. The center expression routes
	// through `compileValueExprOperand`, so a typed-literal center
	// (`term(literal("42.37 -71.11 0 0"))`), a search-input ref
	// (`term(input("user_location"))`), or any non-term expression
	// (e.g. `concat(...)`, `if(...)`) all work — the dispatch
	// recurses through the expression compiler for non-term arms
	// and through compileTerm for term arms.
	const centerText = eb.cast<string>(
		compileValueExprOperand(pred.center, ctx),
		"text",
	);
	const centerLat = splitNumericComponent(centerText, 1);
	const centerLon = splitNumericComponent(centerText, 2);

	// Distance conversion: AST radius × per-unit meters factor.
	// Pre-computed at compile time because PostGIS's `ST_DWithin`
	// expects meters as a scalar, and the AST's per-unit factor
	// is closed-set ({miles, kilometers}) — no runtime branching.
	const distanceMeters = pred.distance * unitToMeters(pred.unit);

	// `ST_DWithin(geography, geography, meters)` — the geography-
	// typed point inputs interpret the coordinates as lat/lon on
	// the WGS-84 ellipsoid (the geography type's documented
	// reference frame, per
	// `https://postgis.net/docs/manual-3.6/ST_GeogFromText.html`:
	// "SRID 4326 is assumed if unspecified"), which is what the
	// stored geopoint format encodes. `ST_GeogFromText('POINT(<lon>
	// <lat>)')` returns a geography directly — no separate cast
	// needed. The WKT string composes through Postgres's
	// `concat(...)` so `<lon>` and `<lat>` flow as typed-builder
	// arguments rather than being interpolated into a raw string.
	const propPoint = geographyPoint(propLon, propLat);
	const centerPoint = geographyPoint(centerLon, centerLat);
	return eb.fn<boolean>("st_dwithin", [
		propPoint,
		centerPoint,
		eb.val(distanceMeters),
	]) as unknown as Expression<SqlBool>;
}

/**
 * Build a PostGIS geography point from runtime longitude / latitude
 * expressions via `ST_GeogFromText('POINT(<lon> <lat>)')`. The WKT
 * payload is constructed at runtime through Postgres's typed
 * `concat(...)` so `lon` and `lat` flow as bound parameters (or
 * computed expressions) rather than being substituted into a raw
 * SQL string.
 *
 * Why `ST_GeogFromText` over `ST_MakePoint(lon, lat)::geography`:
 * `ST_GeogFromText` returns a `geography` value directly so no
 * separate cast token is needed. `geography` is a PostGIS extension
 * type and not in Kysely's `SIMPLE_COLUMN_DATA_TYPES` list (per
 * `node_modules/kysely/dist/cjs/operation-node/data-type-node.d.ts`),
 * so the cast-via-named-type path requires an `Expression<any>`
 * cast token — i.e., raw SQL emission. Routing through
 * `ST_GeogFromText` keeps the entire compose path in the typed
 * function-call surface.
 *
 * WKT (Well-Known Text) coordinate order is `POINT(<lon> <lat>)` —
 * the same `(lon, lat)` order `ST_MakePoint` accepts. SRID 4326 is
 * the documented default per
 * `https://postgis.net/docs/manual-3.6/ST_GeogFromText.html`.
 */
function geographyPoint(
	lon: AliasableExpression<unknown>,
	lat: AliasableExpression<unknown>,
): AliasableExpression<unknown> {
	// Each `eb.val(...)` literal binds as an unknown-typed parameter
	// at prepared-statement time; without an explicit cast Postgres
	// rejects the `concat(...)` call with "could not determine data
	// type of parameter $N" (the prepared-statement type inference
	// cannot route an `unknown` parameter through `concat`'s
	// "implicit cast to text on every arg" promise — `concat`'s arg
	// types are `any`, so Postgres needs each parameter pre-typed).
	// Cast each constant fragment to `text` and each numeric
	// component to `text` so the call binds against
	// `concat(text, text, text, text, text)` — a fully-typed
	// signature Postgres resolves at parse time.
	const wkt = eb.fn<string>("concat", [
		eb.cast<string>(eb.val("POINT("), "text"),
		eb.cast<string>(lon, "text"),
		eb.cast<string>(eb.val(" "), "text"),
		eb.cast<string>(lat, "text"),
		eb.cast<string>(eb.val(")"), "text"),
	]);
	return eb.fn("st_geogfromtext", [wkt]);
}

/**
 * Build a `split_part(<text>, ' ', <pos>)::numeric` expression
 * for one of the four space-separated components of CommCare's
 * geopoint wire form (`"latitude longitude altitude accuracy"`).
 * Used twice for each side of `within-distance` to extract
 * `(lat, lon)` for `ST_MakePoint`.
 */
function splitNumericComponent(
	text: AliasableExpression<string>,
	position: number,
): AliasableExpression<number> {
	const part = eb.fn<string>("split_part", [
		text,
		eb.val(" "),
		eb.val(position),
	]);
	return eb.cast<number>(part, "numeric");
}

/**
 * Closed-enum dispatch: `DistanceUnit` to its meters factor. The
 * exhaustive switch surfaces a future unit at compile time.
 */
function unitToMeters(unit: DistanceUnit): number {
	switch (unit) {
		case "miles":
			return METERS_PER_UNIT.miles;
		case "kilometers":
			return METERS_PER_UNIT.kilometers;
		default: {
			const _exhaustive: never = unit;
			throw new Error(
				unhandledKindMessage({
					where: "compilePredicate.unitToMeters",
					family: "DistanceUnit",
					received: _exhaustive,
					knownKinds: ["miles", "kilometers"],
				}),
			);
		}
	}
}

// ---------------------------------------------------------------
// `exists` / `missing` — relational quantifiers
// ---------------------------------------------------------------

/**
 * Compile an `exists` / `missing` relational quantifier. Strategy:
 * correlated `EXISTS (subquery)` (or `NOT EXISTS (...)` for
 * `missing`) against the relation-path leaf subquery, with the
 * inner `where` predicate (if present) compiled in a context that
 * has its `anchorAlias` swapped to the leaf alias so self-via term
 * reads inside the `where` route through the related case row,
 * not the outer anchor.
 *
 * `via.kind === "self"` is the no-traversal degenerate; wrapping
 * in EXISTS would correlate the anchor against itself and execute
 * one redundant scan. The four collapses:
 *
 *   - `exists(self, where)` → compile `where` directly.
 *   - `exists(self)` → trivial-true sentinel.
 *   - `missing(self, where)` → `NOT (where)`.
 *   - `missing(self)` → trivial-false sentinel.
 *
 * For non-self `via`, the relation-path compiler produces a
 * subquery that exposes `<rp_leaf>.anchor_case_id` as the
 * correlation column. The EXISTS body wraps that subquery with a
 * `WHERE rp_leaf.anchor_case_id = <ctx.anchorAlias>.case_id`
 * correlation plus the inner `where` (if present) compiled in the
 * leaf-alias-anchored context.
 *
 * Postgres reference: § 9.24.2 "Subquery Expressions / EXISTS" —
 * the canonical correlated-EXISTS pattern.
 */
function compileExistsOrMissing(
	pred: Extract<Predicate, { kind: "exists" | "missing" }>,
	ctx: PredicateCompileContext,
	mode: "exists" | "missing",
): Expression<SqlBool> {
	// Self-via collapse — the four cases above.
	if (pred.via.kind === "self") {
		return compileSelfViaQuantifier(pred.where, ctx, mode);
	}

	// Non-self via: build the relation-path leaf subquery. Reuse
	// the path resolution from `compileRelationPath` — same
	// tenant-filter discipline, same depth-1 join shape, same
	// leaf-alias contract. compileRelationPath returns a
	// `{ kind: "joined", buildLeafSubquery, leafAlias }` for every
	// non-self path (the sole `kind: "self"` arm is unreachable
	// here because we branched out of it above).
	const compiledPath = compileRelationPath(pred.via, ctx);
	if (compiledPath.kind !== "joined") {
		// compileRelationPath is exhaustive over `RelationPath` and
		// produces `kind: "self"` only for the `path.kind === "self"`
		// case — which this function branched out of. The narrowing
		// here is for the type system; the runtime branch is dead.
		throw new Error(
			compilerBugMessage({
				where: "compilePredicate.compileExistsOrMissing",
				invariant:
					"a non-`self` `RelationPath` produced a `self` compiled result",
				detail:
					"The upstream branch routes every `pred.via.kind === 'self'` away from this helper before it reaches `compileRelationPath`. Reaching this throw means `compileRelationPath` returned the degenerate `self` marker for a `RelationPath` whose `kind` is not `self` — a contract violation between the two helpers.",
			}),
		);
	}

	// Inner where compiled with the leaf alias as the new anchor and
	// the relation-path depth incremented. Self-via property reads
	// inside the where then route through `<outer-leaf-alias>.properties`
	// — the relation-walk destination — and the term compiler's
	// existing logic handles the JSONB read + cast + reserved-column
	// dispatch unchanged. The depth bump ensures any nested
	// `compileRelationPath` invocation inside the inner where (a
	// nested `exists`/`missing`, or a non-self-via prop term whose
	// JSONB read needs another walk) emits a unique-per-depth alias
	// so the outer correlation reference does not get shadowed by
	// the inner subquery's same-named leaf alias.
	const nextDepth = (ctx.relationPathDepth ?? 0) + 1;
	const innerWhere =
		pred.where !== undefined
			? compilePredicate(pred.where, {
					...ctx,
					anchorAlias: compiledPath.leafAlias,
					relationPathDepth: nextDepth,
				})
			: undefined;

	// Build the EXISTS body via the typed builder. The body shape
	// is `SELECT 1 FROM <leaf> WHERE <leaf>.anchor_case_id =
	// <anchor>.case_id [AND <inner-where>]`. The leaf subquery is
	// an `AliasedExpression` carrying the depth-aware leaf alias
	// (`rp_leaf` at depth 0; `rp_leaf_<N>` at deeper nestings) so
	// nested EXISTS bodies do not shadow each other's leaf alias —
	// see `compileRelationPath`'s "alias isolation" header for the
	// uniquification scheme.
	//
	// Type-erased local view via `DynamicExistsQuery` because TS
	// cannot enumerate the runtime leaf and anchor aliases against
	// `Database`'s typed table set; the runtime calls dispatch
	// through Kysely's typed `whereRef` / `where` / `select`
	// methods on the underlying concrete builder.
	const leafSubquery = compiledPath.buildLeafSubquery();
	const baseQuery = ctx.db.selectFrom(
		leafSubquery as unknown as never,
	) as unknown as DynamicExistsQuery;
	const correlated = baseQuery.whereRef(
		`${compiledPath.leafAlias}.anchor_case_id`,
		"=",
		`${ctx.anchorAlias}.case_id`,
	);
	const withInnerWhere =
		innerWhere !== undefined ? correlated.where(innerWhere) : correlated;
	const subquery = withInnerWhere.select(eb.lit(1).as("one"));
	return mode === "exists"
		? eb.exists(subquery as unknown as Expression<unknown>)
		: eb.not(eb.exists(subquery as unknown as Expression<unknown>));
}

/**
 * Compile the four self-via collapse cases for `exists` /
 * `missing`. The collapse is at the AST-shape level, not at the
 * SQL-emission level — these forms produce trivially-equivalent
 * SQL without consulting the relation-path subquery surface.
 */
function compileSelfViaQuantifier(
	where: Predicate | undefined,
	ctx: PredicateCompileContext,
	mode: "exists" | "missing",
): Expression<SqlBool> {
	if (mode === "exists") {
		// `exists(self)` → trivial-true; `exists(self, where)` →
		// `where` directly.
		return where === undefined
			? (eb.lit(true) as Expression<SqlBool>)
			: compilePredicate(where, ctx);
	}
	// `missing(self)` → trivial-false; `missing(self, where)` →
	// `NOT (where)`.
	return where === undefined
		? (eb.lit(false) as Expression<SqlBool>)
		: eb.not(compilePredicate(where, ctx));
}

// ---------------------------------------------------------------
// `when-input-present` — compile-time short-circuit
// ---------------------------------------------------------------

/**
 * Compile a `when-input-present` predicate. The wrapper applies
 * its `clause` only if the named search input is bound at runtime;
 * otherwise it's a no-op (matches every row).
 *
 * On the Postgres pipeline, search-input bindings are resolved
 * before compilation via `ctx.bindings.searchInputs`. The compiler
 * checks the bindings map at compile time:
 *
 *   - input bound → compile `clause` directly.
 *   - input absent → emit `true` (the AND-chain identity for the
 *     no-input branch — "when the input is absent, don't filter").
 *
 * The compile-time short-circuit is the cleanest match for the
 * Postgres pipeline because runtime-driven semantics aren't
 * reachable: the wider query layer threads bindings into the
 * context BEFORE invoking the compiler. CCHQ's wire targets emit
 * an `if(count(<input>), <clause>, true())` runtime conditional
 * because their evaluation engine doesn't have a compile step
 * separate from execution; the Postgres pipeline does.
 *
 * Bound-vs-blank semantic: "bound" means
 * `ctx.bindings.searchInputs.has(name)` is true regardless of the
 * bound value. An empty-string or null binding is still considered
 * bound and the wrapped clause runs against it. This diverges from
 * CCHQ's wire `count(input)` semantic, which returns 0 for empty
 * strings and skips the clause. The diverge is deliberate: the
 * Postgres pipeline keeps the boundary at "did the request include
 * a value for this input", which is the request-shape signal the
 * caller controls; "is the value semantically empty" is a clause-
 * specific concern the wrapped predicate handles via `is-blank`
 * etc. when the author wants that behavior. Callers that want the
 * CCHQ-aligned semantic strip blank values from `searchInputs`
 * before passing the bindings to the compiler.
 */
function compileWhenInputPresent(
	pred: Extract<Predicate, { kind: "when-input-present" }>,
	ctx: PredicateCompileContext,
): Expression<SqlBool> {
	const isBound = ctx.bindings.searchInputs?.has(pred.input.name) ?? false;
	if (isBound) {
		return compilePredicate(pred.clause, ctx);
	}
	// Input not bound — short-circuit to "match every row".
	return eb.lit(true) as Expression<SqlBool>;
}

// ---------------------------------------------------------------
// Absence checks — `is-null` / `is-blank`
// ---------------------------------------------------------------

/**
 * Shared shape for `is-null` / `is-blank` dispatch. The two
 * operators differ only in whether the empty-string disjunction
 * is included; pulling them through one helper keeps the per-arm
 * dispatch single-source.
 *
 * The four left-operand shapes are:
 *
 *   1. `term` arm wrapping a property ref → JSONB or scalar
 *      column dispatch.
 *   2. `term` arm wrapping a runtime binding (`input` /
 *      `session-user` / `session-context`) → scalar `IS NULL`.
 *   3. `term` arm wrapping a literal → semantically meaningless
 *      ("is the literal 5 absent?"), but structurally typeable;
 *      the type-checker layer rejects this case, so the SQL
 *      compiler trusts the rejection upstream and emits the
 *      standard scalar `IS NULL` form.
 *   4. Non-`term` `ValueExpression` arm → rejected at this layer;
 *      compile non-term ValueExpression operands through the
 *      sibling expression compiler before reaching the predicate
 *      compiler.
 *
 * Postgres-strict null semantics: the property-ref branch reads
 * through the JSONB key-existence operator (`?`), which
 * distinguishes "key absent" from "key present with JSON null"
 * from "key present with empty string". The non-property branches
 * fall back to the standard SQL `IS NULL`, which is the right
 * shape for parameter-bound runtime bindings (no JSONB layer to
 * distinguish).
 */
function compileAbsenceCheck(
	left: ValueExpression,
	ctx: PredicateCompileContext,
	op: "is-null" | "is-blank",
): Expression<SqlBool> {
	// Property-ref dispatch — the only path with a meaningful
	// strict-absent semantic at the storage layer. The JSONB key-
	// existence test (`?` operator) distinguishes "key absent"
	// from "key present with value null", which the standard SQL
	// `IS NULL` cannot.
	if (left.kind === "term" && left.term.kind === "prop") {
		return compilePropertyAbsenceCheck(left.term, ctx, op);
	}

	// Non-property operand — fall back to the standard scalar
	// shape. The four reachable cases all share the same `<expr>
	// IS NULL` shape; the blank form adds `OR <expr> = ''`:
	//   - term wrapping a runtime binding (input / session-user /
	//     session-context) — bound parameter, IS NULL is the
	//     right shape.
	//   - term wrapping a literal — semantically meaningless ("is
	//     the literal 5 absent?"), but structurally typeable; the
	//     type-checker layer rejects this case, and the SQL
	//     compiler trusts the rejection upstream.
	//   - any non-term ValueExpression arm (`arith`, `if`, `count`,
	//     etc.) — routed through the expression compiler via
	//     `compileValueExprOperand` so the absence check applies
	//     to the resolved expression's value.
	const operand = compileValueExprOperand(left, ctx);
	if (op === "is-null") {
		return eb(operand, "is", null);
	}
	return eb.or([eb(operand, "is", null), eb(operand, "=", eb.val(""))]);
}

/**
 * Compile the absence-check dispatch for a property reference.
 * Routes the four shapes — reserved scalar via self, JSONB
 * property via self, reserved scalar via non-self, JSONB property
 * via non-self — to the correct SQL shape.
 *
 * Reserved scalar columns: the column's `IS NULL` (and `OR <col> =
 * ''` for the blank form). The reserved-column rule applies
 * uniformly to anchor reads and leaf-alias reads (the leaf row
 * carries every `cases` column, so the leaf alias surfaces the
 * same scalar columns the anchor does — same shape compileTerm
 * carries).
 *
 * JSONB-document properties: the `?` operator's negation for the
 * absent-key check. The JSONB key-exists operator returns
 * `boolean`; `NOT (... ? '<key>')` matches strict-absent, and the
 * `is-blank` form adds `OR (<source>.properties->>'<key>') = ''`
 * to widen to absent-or-empty.
 *
 * Non-self via: the absence check applies to the property on the
 * walk's destination. The function builds a correlated scalar
 * subquery against the relation-path leaf — same shape the term
 * compiler emits for non-self via reads — and wraps the result
 * with the standard `IS NULL` / `IS NULL OR = ''` test. The
 * scalar-subquery semantic propagates the no-matching-row case as
 * SQL `NULL`, which `IS NULL` reads as absent — "no related case
 * has the property" reads as "the property is null on the related
 * case", matching the term-compiler's value-bearing read of the
 * same shape.
 */
function compilePropertyAbsenceCheck(
	property: Extract<Term, { kind: "prop" }>,
	ctx: PredicateCompileContext,
	op: "is-null" | "is-blank",
): Expression<SqlBool> {
	const isSelfVia = property.via === undefined || property.via.kind === "self";
	const propertyName = property.property;

	if (!isSelfVia) {
		// Non-self via: route through `compileTerm` to inherit the
		// scalar-subquery shape for the value read, then apply the
		// scalar `IS NULL` / `IS NULL OR = ''` test. Routing through
		// the term compiler keeps the absence-check semantic aligned
		// with the value-bearing read every other operand uses for
		// the same shape — a "no related case" row reads as the
		// subquery returning NULL, and `NULL IS NULL` is true.
		const valueRead = compileTerm(property, ctx);
		if (op === "is-null") {
			return eb(valueRead, "is", null);
		}
		return eb.or([eb(valueRead, "is", null), eb(valueRead, "=", eb.val(""))]);
	}

	// Self-via dispatch — the JSONB key-existence shape for
	// JSONB-document properties; the standard `IS NULL` / `OR <col> =
	// ''` shape for reserved scalar columns. Reserved scalar columns
	// live outside the JSONB document, so the `?` operator does not
	// apply.
	const sourceAlias = ctx.anchorAlias;
	if (RESERVED_SCALAR_COLUMNS.has(propertyName)) {
		const columnRef = (eb as DynamicExprBuilder).ref(
			`${sourceAlias}.${propertyName}`,
		);
		if (op === "is-null") {
			return eb(columnRef, "is", null);
		}
		return eb.or([eb(columnRef, "is", null), eb(columnRef, "=", eb.val(""))]);
	}

	// JSONB-document property: key-existence test plus the
	// optional empty-string disjunction. The `?` operator
	// (Postgres JSONB key-exists) is in `COMPARISON_OPERATORS`,
	// returning `boolean`; negation via `eb.not` matches strict-
	// absent. The blank form adds the `properties->>'<key>' = ''`
	// disjunction for absent-or-empty.
	const propertiesRef = `${sourceAlias}.properties` as const;
	const keyExists = (eb as DynamicExprBuilder)(
		propertiesRef,
		"?",
		propertyName,
	) as Expression<SqlBool>;
	if (op === "is-null") {
		return eb.not(keyExists);
	}
	const textRead = (eb as DynamicExprBuilder)(
		propertiesRef,
		"->>",
		propertyName,
	);
	return eb.or([eb.not(keyExists), eb(textRead, "=", eb.val(""))]);
}

// ---------------------------------------------------------------
// Type-erased typed-builder views
// ---------------------------------------------------------------

/**
 * Type-erased local view of the standalone expression builder for
 * binary-op calls and column references whose first argument is a
 * runtime-derived `${alias}.${column}` string. The runtime call
 * resolves correctly because every concrete site names a
 * `cases`-shaped row at the alias position; the cast pins the
 * public expression contract.
 *
 * Mirrors the same shape `compileTerm` uses for its
 * runtime-aliased reads — see the `DynamicExprBuilder` JSDoc in
 * compileTerm.ts for the alias-isolation rationale.
 */
type DynamicExprBuilder = {
	(left: string, op: string, right: unknown): AliasableExpression<unknown>;
	ref: (reference: string) => AliasableExpression<unknown>;
};

/**
 * Type-erased local view of the EXISTS subquery's builder during
 * `compileExistsOrMissing`. The subquery starts from the
 * relation-path leaf `AliasedExpression`, applies a correlation
 * predicate against the outer anchor's `case_id`, optionally
 * intersects an inner `where`, and projects a constant `1` to
 * close the EXISTS body.
 *
 * The typed builder cannot enumerate the leaf alias against
 * `Database`'s table key set (the leaf is a synthesized
 * subquery, not a table); the calls operate through this minimal
 * interface and the cast back to `Expression<unknown>` happens at
 * the public boundary.
 */
interface DynamicExistsQuery {
	whereRef: (left: string, op: string, right: string) => DynamicExistsQuery;
	where: (predicate: Expression<unknown>) => DynamicExistsQuery;
	select: (selection: AliasedExpression<unknown, string>) => DynamicExistsQuery;
}
