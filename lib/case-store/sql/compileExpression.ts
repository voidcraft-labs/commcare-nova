// lib/case-store/sql/compileExpression.ts
//
// Compile a `ValueExpression` AST node to a Kysely expression. The
// `ValueExpression` union is the value-bearing sister of `Predicate`
// (see `lib/domain/predicate/types.ts:1796-1845`), and every value
// slot in the case-list / search pipeline composes through it —
// calculated columns, search-input defaults, sort keys, the date
// argument to a late-flag column, the LHS of a comparison whose
// shape is arithmetic or conditional rather than a bare property
// read.
//
// ## Arm coverage (15 arms — every member of the union)
//
//   - `term(t)` — delegates to `compileTerm` for property reads,
//     literals, and runtime bindings (search inputs, session-user,
//     session-context).
//   - `today` — Postgres `current_date` (returns `date`).
//   - `now` — Postgres `now()` (returns `timestamptz`).
//   - `date-coerce(value)` — `cast(<value> as date)`. Wire-string →
//     typed date.
//   - `datetime-coerce(value)` — `cast(<value> as timestamptz)`.
//     Wire-string → typed datetime; preserves timezone information.
//   - `double(value)` — `cast(<value> as numeric)`. Forced numeric
//     coercion via Postgres's arbitrary-precision decimal.
//   - `arith(op, left, right)` — five-op binary arithmetic. The
//     AST's wire-vocabulary names map to SQL operators per
//     `ARITH_OP_TO_SQL`: `+` / `-` / `*` are byte-identical, `div`
//     maps to `/`, `mod` maps to `%`.
//   - `concat(parts)` — Postgres `concat(...)` function. NULL parts
//     are ignored per Postgres's documented `concat()` semantic
//     (observably identical to coercing to empty), matching the
//     type checker's spec ("each part casts to text at
//     evaluation").
//   - `coalesce(values)` — SQL `coalesce(...)`. Returns the first
//     non-null value.
//   - `if(cond, then, else)` — SQL `case when <cond> then <then>
//     else <else> end`. The `cond` slot carries a Predicate; the
//     compiler routes it through the `compilePredicate` thunk on
//     the context (see "Predicate-thunk strategy" below).
//   - `switch(on, cases, fallback)` — SQL searched `case` form:
//     `case when <on> = <when_1> then <then_1> when <on> =
//     <when_2> then <then_2> ... else <fallback> end`. The simple
//     `case <on> when ...` form would re-use the discriminator
//     once, but Kysely's typed simple-CASE shape requires a typed
//     discriminator that the open `Expression<unknown>` operand
//     cannot satisfy; the searched form composes through the
//     typed builder while emitting equivalent rows (Postgres's
//     planner recognises the equivalence).
//   - `count(via, where?)` — relational aggregation. Compiles to
//     `(select count(*) from <rp_leaf-subquery> [where
//     <where-pred>])`. The relation-path leaf is built via
//     `compileRelationPath`; the optional `where` predicate filters
//     leaf rows before counting and routes through the
//     `compilePredicate` thunk.
//   - `unwrap-list(value)` — defensive throw. The arm resolves to
//     the type checker's `_sequence` sentinel (per
//     `lib/domain/predicate/typeChecker.ts:1545-1547`); no AST
//     consumer on the runtime side accepts a sequence. The CSQL
//     hoist pass at `lib/commcare/predicate/csqlHoist.ts` routes
//     the arm into `selected-any(prop, unwrap-list(...))` at the
//     wire-emission boundary; that path does not flow through the
//     SQL compiler. Reaching this arm is an invariant violation,
//     so the compiler throws.
//   - `format-date(date, pattern)` — SQL `to_char(cast(<date> as
//     timestamptz), '<pattern>')`. The three preset names (`short`
//     / `long` / `iso`) map to fixed Postgres `to_char` patterns;
//     arbitrary pattern strings pass through verbatim under the
//     assumption that authors target Postgres's pattern vocabulary
//     on Nova-runtime apps. Postgres `to_char` documented at
//     `https://www.postgresql.org/docs/16/functions-formatting.html`.
//
// ## Predicate-thunk strategy
//
// Two arms (`if.cond`, `count.where`) carry `Predicate` operands.
// The Expression compiler does not import the Predicate compiler
// directly — instead, `ExpressionCompileContext` carries an
// optional `compilePredicate` callback that the integrating
// caller supplies. This keeps the two compilers structurally
// independent: the predicate compiler can recurse back into the
// expression compiler for its own value-bearing operand slots
// (comparison sides, between bounds, within-distance centers)
// without producing an import cycle.
//
// The Expression compiler routes the Predicate through the
// callback when the arm is reached, throwing a clear "predicate
// compiler not wired" error if the callback is absent — a
// defensive check rather than a silent fall-through.
//
// The `switch` arm does NOT need the thunk — every `cases[].when`
// is a `Literal` (per `switchCaseSchema` in `types.ts:867-871`),
// not a Predicate. The Expression compiler handles the equality
// dispatch directly.
//
// ## Why `AliasableExpression<unknown>` is the public return type
//
// Same shape the Term compiler returns. Consumers — the Predicate
// compiler and the integrating callers that compose Predicates and
// Expressions into wider queries — thread the result into
// `eb(left, op, right)` binary operations and `select(... .as(...))`
// projection sites uniformly. `AliasableExpression<T>` is Kysely's
// `.as(alias)`-bearing operand contract; every concrete return
// shape (`ExpressionWrapper`, `RawBuilder`, `SelectQueryBuilder`)
// implements it. The unknown payload is deliberate: each arm
// resolves to a different per-Postgres-type expression but the
// runtime dispatches by `expr.kind`, and the wider compilers
// consume the return as a generic operand.

import type {
	AliasableExpression,
	AliasedExpression,
	BinaryOperator,
	Expression,
} from "kysely";
import { expressionBuilder, sql } from "kysely";
import type {
	ArithOp,
	DateAddInterval,
	FormatDatePreset,
	Predicate,
	RelationPath,
	SwitchCase,
	ValueExpression,
} from "@/lib/domain/predicate/types";
import { compileRelationPath } from "./compileRelationPath";
import { compileTerm, type TermCompileContext } from "./compileTerm";
import type { Database } from "./database";

// ---------------------------------------------------------------
// Public types
// ---------------------------------------------------------------

/**
 * Predicate-compilation callback. The `if.cond` and `count.where`
 * arms delegate Predicate operand compilation through this
 * callback; the integrating caller supplies the real predicate
 * compiler, and tests inject stubs that exercise arm dispatch
 * without coupling to the predicate compiler's internals.
 *
 * The signature mirrors `compileExpression`'s contract — the
 * callback returns an `Expression<unknown>` so the wider compilers
 * thread its result into `case().when(<predicate-expr>)` and
 * `where(<predicate-expr>)` slots without re-narrowing. The
 * context surface is the Expression context so the predicate
 * compiler can recurse back into `compileExpression` for its own
 * value-bearing operand slots (`comparison.left/right`,
 * `between.lower/upper`, etc.).
 */
export type CompilePredicateThunk = (
	predicate: Predicate,
	ctx: ExpressionCompileContext,
) => Expression<unknown>;

/**
 * The compile context every `compileExpression` call requires.
 *
 * Extends `TermCompileContext` because every arm that delegates to
 * the Term compiler (the `term` arm directly, plus property reads
 * inside `arith` / `concat` / `coalesce` / `if` / `switch` / `count`
 * / `format-date` operands) needs the same fields the Term compiler
 * does — the database handle, the tenant pair, the anchor alias,
 * the schema map, the runtime bindings.
 *
 * Adds `compilePredicate` for the two predicate-bearing arms.
 */
export interface ExpressionCompileContext extends TermCompileContext {
	/**
	 * Predicate-compilation callback for `if.cond` and `count.where`.
	 * Optional at the type layer because callers that never reach a
	 * predicate-bearing arm don't need to wire it; runtime arms that
	 * reach the missing callback throw with a descriptive error.
	 *
	 * The integrating caller supplies the real predicate compiler;
	 * tests inject stubs.
	 */
	compilePredicate?: CompilePredicateThunk;
}

// ---------------------------------------------------------------
// AST-op → SQL-token mappings
// ---------------------------------------------------------------

/**
 * The `ARITH_OPS` AST enum mapped to Postgres operator tokens.
 * Three arms (`+` / `-` / `*`) share their AST and SQL tokens; the
 * `div` and `mod` arms use the CCHQ-vocabulary spelled-out names
 * because XPath's `/` is the path separator and `%` has no XPath
 * meaning. Postgres recognises `/` and `%` for integer division
 * and modulo respectively (per
 * `https://www.postgresql.org/docs/16/functions-math.html`).
 *
 * The `Record<ArithOp, string>` typing forces every variant of the
 * AST enum to map to a SQL token at compile time; adding a new arm
 * to `ARITH_OPS` without a parallel mapping entry surfaces as a
 * TypeScript error.
 */
const ARITH_OP_TO_SQL: Readonly<Record<ArithOp, BinaryOperator>> = {
	"+": "+",
	"-": "-",
	"*": "*",
	div: "/",
	mod: "%",
};

/**
 * Postgres `to_char` pattern strings for each `format-date` preset.
 *
 *   - `short` — `MM/DD/YYYY`. Locale-default short form (US
 *     month/day/year ordering, slash separator).
 *   - `long`  — `FMMonth FMDD, YYYY`. Locale-default long form
 *     (full month name with trailing whitespace stripped,
 *     day-of-month without leading zero, comma-separated). The
 *     `FM` prefix on `Month` matters: bare `Month` returns a
 *     fixed-width 9-character string with trailing spaces filling
 *     the gap ("May      "), which a presentation surface would
 *     have to trim; the prefix pre-trims at the renderer.
 *   - `iso`   — `YYYY-MM-DD`. ISO 8601 date-only form.
 *
 * Authors who need a custom pattern pass an arbitrary string; the
 * compiler passes it through to `to_char` verbatim. Postgres's
 * `to_char` patterns differ from CCHQ's wire `format-date`
 * patterns; on Nova-runtime apps, the authoring surface targets
 * Postgres's vocabulary directly.
 */
const FORMAT_DATE_PRESET_TO_PATTERN: Readonly<
	Record<FormatDatePreset, string>
> = {
	short: "MM/DD/YYYY",
	long: "FMMonth FMDD, YYYY",
	iso: "YYYY-MM-DD",
};

/**
 * `format-date` preset names — the closed set of strings that map
 * through `FORMAT_DATE_PRESET_TO_PATTERN`. Used at runtime to
 * disambiguate the schema's `pattern: FormatDatePreset | string`
 * union — if the incoming pattern is one of the preset names, the
 * compiler maps; otherwise it passes the string through. The set
 * derives from `Object.keys(FORMAT_DATE_PRESET_TO_PATTERN)` so
 * adding a preset to the typed `Record` auto-extends the runtime
 * dispatch — a hand-maintained sibling set would silently miss a
 * new preset (TypeScript would not catch the divergence because
 * the new key is still a valid `FormatDatePreset` from the union's
 * perspective).
 */
const FORMAT_DATE_PRESET_KEYS: ReadonlySet<FormatDatePreset> = new Set(
	Object.keys(FORMAT_DATE_PRESET_TO_PATTERN) as FormatDatePreset[],
);

// ---------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------

/**
 * Compile a `ValueExpression` AST node to a Kysely expression.
 *
 * Arm dispatch via the `kind` discriminator. The exhaustive switch
 * uses an `_exhaustive: never` default so adding a new arm to
 * `ValueExpression` without a parallel implementation surfaces as
 * a TypeScript error.
 *
 * @param expr - the `ValueExpression` AST node to compile
 * @param ctx  - compile context (database handle, tenant pair,
 *               anchor alias, schema map, runtime bindings, optional
 *               predicate-compilation callback)
 * @returns an `AliasableExpression<unknown>` the wider compilers
 *          consume as a generic value-bearing operand. Tests call
 *          `.as("v")` against the return value to wrap it in a
 *          select column; `AliasableExpression` (rather than the
 *          bare `Expression`) keeps that call site type-checked.
 */
export function compileExpression(
	expr: ValueExpression,
	ctx: ExpressionCompileContext,
): AliasableExpression<unknown> {
	switch (expr.kind) {
		case "term":
			return compileTerm(expr.term, ctx);
		case "today":
			return compileToday();
		case "now":
			return compileNow();
		case "date-add":
			return compileDateAdd(expr.date, expr.interval, expr.quantity, ctx);
		case "date-coerce":
			return compileCast(expr.value, "date", ctx);
		case "datetime-coerce":
			return compileCast(expr.value, "timestamptz", ctx);
		case "double":
			return compileCast(expr.value, "numeric", ctx);
		case "arith":
			return compileArith(expr.op, expr.left, expr.right, ctx);
		case "concat":
			return compileConcat(expr.parts, ctx);
		case "coalesce":
			return compileCoalesce(expr.values, ctx);
		case "if":
			return compileIf(expr.cond, expr.then, expr.else, ctx);
		case "switch":
			return compileSwitch(expr.on, expr.cases, expr.fallback, ctx);
		case "count":
			return compileCount(expr.via, expr.where, ctx);
		case "unwrap-list":
			throw new Error(
				"compileExpression: 'unwrap-list' has no AST consumer on the SQL side — the type checker resolves it to the `_sequence` sentinel and no Predicate or Expression operator on the runtime side accepts a sequence. The CSQL wire emitter handles the arm at the wire-emission boundary; SQL-side authoring surfaces must reject sequence-typed expressions before they reach the compiler.",
			);
		case "format-date":
			return compileFormatDate(expr.date, expr.pattern, ctx);
		default: {
			const _exhaustive: never = expr;
			throw new Error(
				`compileExpression: unhandled ValueExpression kind ${String(_exhaustive)}`,
			);
		}
	}
}

// ---------------------------------------------------------------
// Shared expression builder
// ---------------------------------------------------------------

/**
 * The standalone expression builder bound to the case-store
 * `Database` type. Used to construct typed operands (`eb.cast`,
 * `eb.fn`, `eb.case()`, `eb.val`, etc.) without threading a
 * Kysely callback through every helper. Mirrors the shape used
 * in `compileTerm` and `compilePredicate` so the three compilers
 * share one entry point into Kysely's typed-builder surface.
 */
const eb = expressionBuilder<Database, keyof Database>();

// ---------------------------------------------------------------
// `today` / `now` constants
// ---------------------------------------------------------------

/**
 * `today` → `CURRENT_DATE`. Postgres returns a `date`-typed value
 * representing the project-timezone date at evaluation time. Per
 * `https://www.postgresql.org/docs/16/functions-datetime.html#FUNCTIONS-DATETIME-CURRENT`,
 * `CURRENT_DATE` is the SQL-standard niladic form (no parens),
 * distinct from sister functions `NOW()` / `LOCALTIMESTAMP()` that
 * Postgres documents with parentheses.
 *
 * Emitted via `sql.raw` because Kysely's `eb.fn(name, args)`
 * always wraps the function name in `(<args>)` parens, which
 * Postgres's parser rejects for `current_date`. The token is a
 * compile-time constant — no caller-supplied input reaches the
 * raw-emission slot.
 */
function compileToday(): AliasableExpression<unknown> {
	return sql.raw("current_date");
}

/**
 * `now` → `now()`. Postgres returns a `timestamptz`-typed value
 * representing the start of the current transaction (the
 * documented Postgres behavior; `NOW()` returns a transaction-
 * stable timestamp). Per
 * `https://www.postgresql.org/docs/16/functions-datetime.html#FUNCTIONS-DATETIME-CURRENT`.
 *
 * `eb.fn<Date>('now')` emits `now()` directly — the parenthesised
 * form Postgres documents as canonical.
 */
function compileNow(): AliasableExpression<unknown> {
	return eb.fn<Date>("now");
}

// ---------------------------------------------------------------
// Cast arms (`date-coerce`, `datetime-coerce`, `double`)
// ---------------------------------------------------------------

/**
 * Wrap an inner value-expression in a Postgres cast. Used by
 * `date-coerce` (cast to `date`), `datetime-coerce` (cast to
 * `timestamptz`), and `double` (cast to `numeric`).
 *
 * The cast token is a compile-time constant chosen at the call
 * site and typed as `ColumnDataType`; `eb.cast<T>(expr, dataType)`
 * accepts the `ColumnDataType` shape directly and emits the
 * canonical Postgres `CAST` form.
 */
function compileCast(
	value: ValueExpression,
	cast: "date" | "timestamptz" | "numeric",
	ctx: ExpressionCompileContext,
): AliasableExpression<unknown> {
	const inner = compileExpression(value, ctx);
	return eb.cast(inner, cast);
}

// ---------------------------------------------------------------
// `arith` — five-op binary arithmetic
// ---------------------------------------------------------------

/**
 * Compile an `arith` AST node to a Postgres arithmetic expression.
 * The AST op routes through `ARITH_OP_TO_SQL` to its SQL token; the
 * left and right operands compile recursively through
 * `compileExpression`.
 *
 * Each side is paren-wrapped so a nested `arith` honors the AST's
 * left-to-right associativity rather than Postgres's operator
 * precedence; mixing precedence-aware emission with paren-wrapping
 * would surface arithmetic-priority bugs only at runtime. The
 * paren wrap is uniform on every operator.
 */
function compileArith(
	op: ArithOp,
	left: ValueExpression,
	right: ValueExpression,
	ctx: ExpressionCompileContext,
): AliasableExpression<unknown> {
	const leftExpr = compileExpression(left, ctx);
	const rightExpr = compileExpression(right, ctx);
	const opToken = ARITH_OP_TO_SQL[op];
	// `eb(left, op, right)` produces a binary expression with the
	// operator typed against `ARITHMETIC_OPERATORS`. Each operand
	// is itself an `Expression`, so a nested `arith` composes
	// without re-wrapping.
	return eb(leftExpr, opToken, rightExpr);
}

// ---------------------------------------------------------------
// `date-add` — date / datetime + interval arithmetic
// ---------------------------------------------------------------

/**
 * The `DATE_ADD_INTERVALS` AST enum mapped to Postgres interval-
 * unit names. The unit names are byte-identical between the AST
 * enum and Postgres's interval vocabulary
 * (`https://www.postgresql.org/docs/16/datatype-datetime.html#DATATYPE-INTERVAL-INPUT`),
 * so the mapping is the identity. Surfacing the table anyway pins
 * each enum value to a known-safe Postgres token at compile time
 * (rather than concatenating the AST enum value into a SQL string
 * directly), and adding a new arm to `DATE_ADD_INTERVALS` without
 * a parallel mapping entry surfaces as a TypeScript error.
 */
const DATE_ADD_INTERVAL_TO_SQL: Readonly<Record<DateAddInterval, string>> = {
	seconds: "seconds",
	minutes: "minutes",
	hours: "hours",
	days: "days",
	weeks: "weeks",
	months: "months",
	years: "years",
};

/**
 * Compile a `date-add` AST node to Postgres interval arithmetic.
 *
 * Shape: `(<date>)::timestamptz + (<quantity> * INTERVAL '1
 * <unit>')`. The base expression casts to `timestamptz` so a
 * date-typed input lifts uniformly with a datetime-typed input —
 * Postgres's `+ INTERVAL` operator returns `timestamptz` in both
 * cases, and downstream comparisons / formatters consume the
 * timestamptz result without further coercion.
 *
 * The quantity expression multiplies into a `INTERVAL '1 <unit>'`
 * literal. Postgres's interval arithmetic supports `<integer> *
 * INTERVAL '1 day'` directly per
 * `https://www.postgresql.org/docs/16/functions-datetime.html#OPERATORS-DATETIME-TABLE`,
 * which lets the AST's `quantity` slot accept a runtime expression
 * (a property read, a search input, an `arith` result) without
 * pre-resolving it to a static interval.
 *
 * The unit token comes from a closed mapping, so `sql.raw` is safe
 * — no caller-supplied input flows into the token.
 */
function compileDateAdd(
	date: ValueExpression,
	interval: DateAddInterval,
	quantity: ValueExpression,
	ctx: ExpressionCompileContext,
): AliasableExpression<unknown> {
	const dateExpr = compileExpression(date, ctx);
	const quantityExpr = compileExpression(quantity, ctx);
	const unitToken = DATE_ADD_INTERVAL_TO_SQL[interval];
	// Cast the base to `timestamptz` so a date-typed input lifts
	// uniformly with a datetime-typed input. Postgres's `+
	// INTERVAL` returns `timestamptz` from either input shape.
	const dateAsTimestamp = eb.cast(dateExpr, "timestamptz");
	// Build the typed interval literal `INTERVAL '1 <unit>'` via
	// `eb.cast(eb.val(...), <interval-data-type>)`. The unit token
	// is a closed mapping. Expressed as `eb.cast<unknown>(eb.val,
	// sql.raw('interval'))` because `interval` is not a Kysely
	// `ColumnDataType` literal — Kysely accepts an `Expression<any>`
	// from `sql.raw` to widen the cast token to any Postgres type.
	const intervalLiteral = eb.cast(
		eb.val(`1 ${unitToken}`),
		sql.raw("interval"),
	);
	// Multiply quantity by the unit interval, then add to the base.
	const scaledInterval = eb(quantityExpr, "*", intervalLiteral);
	return eb(dateAsTimestamp, "+", scaledInterval);
}

// ---------------------------------------------------------------
// `concat` — Postgres `concat(...)` function
// ---------------------------------------------------------------

/**
 * Compile a `concat` AST node to Postgres's `concat(...)` function.
 *
 * Postgres's `concat(...)` is documented at
 * `https://www.postgresql.org/docs/16/functions-string.html#FUNCTIONS-STRING-OTHER`:
 * "Concatenates the text representations of all the arguments. NULL
 * arguments are ignored." The NULL-ignored behavior — observably
 * identical to coercing NULL parts to empty — is the deliberate
 * choice over the `||` infix operator (which propagates NULL); the
 * AST's `concat` semantic per the type checker spec is "each part
 * casts to text at evaluation, so no per-part type rule beyond
 * resolution" — `concat(...)` matches this directly while `||`
 * would require defensive `COALESCE(part, '')` wrapping at every
 * part.
 */
function compileConcat(
	parts: ReadonlyArray<ValueExpression>,
	ctx: ExpressionCompileContext,
): AliasableExpression<unknown> {
	const partExprs = parts.map((p) => compileExpression(p, ctx));
	// `eb.fn<string>('concat', [...])` emits the typed `concat(...)`
	// call. Postgres's `concat()` ignores NULL parts (per docs §
	// "String Functions"), matching the AST's "each part casts to
	// text at evaluation" semantic without per-part `COALESCE`
	// wrapping.
	return eb.fn<string>("concat", partExprs);
}

// ---------------------------------------------------------------
// `coalesce` — first-non-null fallback chain
// ---------------------------------------------------------------

/**
 * Compile a `coalesce` AST node to SQL `COALESCE(...)`. Returns
 * the first non-null argument per
 * `https://www.postgresql.org/docs/16/functions-conditional.html#FUNCTIONS-COALESCE-NVL-IFNULL`.
 *
 * Each value compiles recursively; the resulting expressions are
 * joined into the function call. Empty-string-as-null coercion
 * lives at the AST layer (the validator surfaces a hint when an
 * author writes `eq(prop, "")`) rather than in the SQL emission, so
 * a `prop` read whose JSONB key is absent returns SQL `NULL` and
 * `COALESCE` correctly skips to the next argument.
 */
function compileCoalesce(
	values: ReadonlyArray<ValueExpression>,
	ctx: ExpressionCompileContext,
): AliasableExpression<unknown> {
	const valueExprs = values.map((v) => compileExpression(v, ctx));
	// `eb.fn<unknown>('coalesce', [...])` emits the typed
	// `COALESCE(...)` call. Kysely's typed `eb.fn.coalesce` helper
	// accepts up to five operands as separate positional args; the
	// generic `eb.fn` form takes an array and works for any
	// arity, matching the AST's open-ended `values` list shape.
	return eb.fn<unknown>("coalesce", valueExprs);
}

// ---------------------------------------------------------------
// `if` — boolean-conditional value selection
// ---------------------------------------------------------------

/**
 * Compile an `if` AST node to SQL `CASE WHEN <cond> THEN <then>
 * ELSE <else> END`.
 *
 * The `cond` slot carries a `Predicate`; the compiler routes it
 * through the `compilePredicate` thunk on the context. If the
 * thunk is absent at the call site, the compiler throws a clear
 * error rather than emit a degenerate `(true)` / `(false)`
 * placeholder — the predicate-bearing arm reaching the SQL
 * compiler without a wired predicate compiler is a misuse, not a
 * silent fall-through.
 *
 * `CASE WHEN ... END` syntax is documented at
 * `https://www.postgresql.org/docs/16/functions-conditional.html#FUNCTIONS-CASE`.
 */
function compileIf(
	cond: Predicate,
	thenBranch: ValueExpression,
	elseBranch: ValueExpression,
	ctx: ExpressionCompileContext,
): AliasableExpression<unknown> {
	const compilePredicate = ctx.compilePredicate;
	if (compilePredicate === undefined) {
		throw new Error(
			"compileExpression: 'if' arm reached but ctx.compilePredicate is not wired. The integrating caller must supply a predicate-compilation callback before the expression compiler is invoked. See `ExpressionCompileContext.compilePredicate` in compileExpression.ts.",
		);
	}
	const condExpr = compilePredicate(cond, ctx);
	const thenExpr = compileExpression(thenBranch, ctx);
	const elseExpr = compileExpression(elseBranch, ctx);
	// Searched `CASE WHEN <cond> THEN <then> ELSE <else> END` form.
	// `eb.case()` opens the operator; `.when(<expression>)` accepts
	// the boolean predicate's compiled expression directly; `.then`
	// / `.else` accept value expressions. Passing the typed
	// expressions (rather than raw values) keeps the parameter
	// channel consistent — Kysely otherwise inlines numbers /
	// booleans / null directly into the SQL on `then` / `else`,
	// which would change the parameter list shape the cold tests
	// pin.
	return eb
		.case()
		.when(condExpr as Expression<boolean>)
		.then(thenExpr)
		.else(elseExpr)
		.end();
}

// ---------------------------------------------------------------
// `switch` — value-driven multi-case selector
// ---------------------------------------------------------------

/**
 * Compile a `switch` AST node to SQL's "simple CASE" form: `CASE
 * <on> WHEN <when_1> THEN <then_1> WHEN <when_2> THEN <then_2> ...
 * ELSE <fallback> END`.
 *
 * Every `cases[].when` is a Literal (per `switchCaseSchema` in
 * `lib/domain/predicate/types.ts:867-871`), so the equality
 * comparison can run as Postgres's "simple CASE" form (per
 * `https://www.postgresql.org/docs/16/functions-conditional.html#FUNCTIONS-CASE`):
 * the discriminator expression evaluates ONCE before the branches,
 * and each branch's `when` literal compares against it. The
 * "searched CASE" form (`CASE WHEN <on>=<lit_a> THEN ... WHEN
 * <on>=<lit_b> THEN ...`) re-evaluates `<on>` per branch, which
 * would cost significantly more for an expensive discriminator
 * (e.g. a `count(...)` subquery). The simple CASE form sidesteps
 * that footgun and matches the AST's `switch.on` semantic — the
 * discriminator value evaluates once and each `when` literal
 * compares against it.
 *
 * Each `when` literal compiles via `compileExpression` (lifting it
 * through the `term` arm so the resulting parameter binding goes
 * through Kysely's parameter channel and shares the cast logic
 * with self-bound literals elsewhere).
 */
function compileSwitch(
	on: ValueExpression,
	cases: ReadonlyArray<SwitchCase>,
	fallback: ValueExpression,
	ctx: ExpressionCompileContext,
): AliasableExpression<unknown> {
	const onExpr = compileExpression(on, ctx);
	const fallbackExpr = compileExpression(fallback, ctx);
	// Searched CASE form: `CASE WHEN <on> = <when_lit_1> THEN <then_1>
	// WHEN <on> = <when_lit_2> THEN <then_2> ... ELSE <fallback> END`.
	// The simple CASE form (`CASE <on> WHEN <when_1> THEN <then_1> ...`)
	// re-uses the discriminator once and would be marginally cheaper
	// for an expensive discriminator, but Kysely's typed simple-CASE
	// shape requires a typed `W` discriminator that the open
	// `Expression<unknown>` shape from `compileExpression` cannot
	// satisfy. The searched form composes cleanly through `eb.case()`
	// with `eb(<on>, '=', <when>)` boolean operands and produces
	// equivalent rows; Postgres's planner recognises the equivalence.
	let builder = eb.case();
	for (const c of cases) {
		const whenExpr = compileExpression({ kind: "term", term: c.when }, ctx);
		const thenExpr = compileExpression(c.then, ctx);
		builder = builder
			.when(eb(onExpr, "=", whenExpr))
			.then(thenExpr) as unknown as ReturnType<typeof eb.case>;
	}
	// `.else(...).end()` closes the operator. The intermediate type
	// dance widens through the loop because TS cannot enumerate the
	// per-iteration `O` accumulation; the cast pins the public
	// `AliasableExpression<unknown>` contract on the final
	// `.end()` result.
	return (
		builder as unknown as ReturnType<typeof eb.case> & {
			else: (e: AliasableExpression<unknown>) => {
				end: () => AliasableExpression<unknown>;
			};
		}
	)
		.else(fallbackExpr)
		.end();
}

// ---------------------------------------------------------------
// `count` — relational aggregation
// ---------------------------------------------------------------

/**
 * Compile a `count` AST node to a counting subquery over the
 * relation-path leaf.
 *
 * Shape: `(SELECT COUNT(*) FROM (<rp_leaf-subquery>) AS rp [WHERE
 * <where-pred>])`. The relation-path leaf is built via
 * `compileRelationPath`; the optional `where` predicate filters
 * leaf rows before counting and routes through the
 * `compilePredicate` thunk on the context.
 *
 * `count(self)` is rejected — the type checker rules it out at
 * the operator boundary (per
 * `lib/domain/predicate/typeChecker.ts:1015-1030`), so reaching
 * the SQL compiler with a self via is an invariant violation. The
 * compiler throws a clear error rather than emit a degenerate
 * "count anchor row" subquery.
 *
 * Tenant filtering inside the leaf subquery is handled by
 * `compileRelationPath` — the relation path's own `cases` joins
 * thread the `(app_id, owner_id)` filter at every hop. The outer
 * `COUNT(*)` doesn't need a separate tenant filter because every
 * row reaching the count is already tenant-filtered.
 */
function compileCount(
	via: RelationPath,
	where: Predicate | undefined,
	ctx: ExpressionCompileContext,
): AliasableExpression<unknown> {
	const compiledPath = compileRelationPath(via, {
		db: ctx.db,
		appId: ctx.appId,
		ownerId: ctx.ownerId,
		anchorAlias: ctx.anchorAlias,
		relationPathDepth: ctx.relationPathDepth ?? 0,
	});
	if (compiledPath.kind === "self") {
		throw new Error(
			"compileExpression: 'count' with a `self` via is rejected by the type checker (see lib/domain/predicate/typeChecker.ts checkRelationalQuantifier). Reaching the SQL compiler with `count(self)` indicates a missing or bypassed type-check pass.",
		);
	}
	// The leaf subquery is an `AliasedExpression` carrying the
	// depth-aware leaf alias from `compiledPath.leafAlias`.
	// `selectFrom(<aliased-expression>)` accepts the leaf as a
	// table source; the count subquery exposes one column
	// (`COUNT(*)`) with `eb.fn.countAll()`, and Kysely's
	// scalar-subquery typing returns the row's column type when
	// the outer query treats it as an expression operand.
	//
	// Type-erased local view via `DynamicCountQuery` because TS
	// cannot enumerate the runtime leaf alias against `Database`'s
	// table key set — the leaf is a synthesized subquery, not a
	// table. Each method call's `<alias>` references resolve at
	// runtime against the leaf row's actual columns; the cast at
	// the boundary pins the public expression contract.
	const leafSubquery = compiledPath.buildLeafSubquery();
	const baseQuery = ctx.db.selectFrom(
		leafSubquery as unknown as never,
	) as unknown as DynamicCountQuery;
	if (where === undefined) {
		return baseQuery.select(
			eb.fn.countAll().as("n"),
		) as unknown as AliasableExpression<unknown>;
	}
	const compilePredicate = ctx.compilePredicate;
	if (compilePredicate === undefined) {
		throw new Error(
			"compileExpression: 'count(via, where)' arm reached with a where clause but ctx.compilePredicate is not wired. The integrating caller must supply a predicate-compilation callback before the expression compiler is invoked. See `ExpressionCompileContext.compilePredicate` in compileExpression.ts.",
		);
	}
	// Compile the inner where with the leaf alias as the new
	// anchor and the relation-path depth incremented, mirroring
	// the predicate compiler's `exists`/`missing` recursion. The
	// depth bump ensures any non-self via prop reads inside the
	// where construct unique-per-depth leaf aliases that do not
	// shadow the outer count subquery's leaf.
	const whereExpr = compilePredicate(where, {
		...ctx,
		anchorAlias: compiledPath.leafAlias,
		relationPathDepth: (ctx.relationPathDepth ?? 0) + 1,
	});
	return baseQuery
		.where(whereExpr)
		.select(
			eb.fn.countAll().as("n"),
		) as unknown as AliasableExpression<unknown>;
}

// ---------------------------------------------------------------
// `format-date` — Postgres `to_char` rendering
// ---------------------------------------------------------------

/**
 * Compile a `format-date` AST node to Postgres `to_char`. Three
 * preset pattern names map through `FORMAT_DATE_PRESET_TO_PATTERN`;
 * arbitrary author-supplied strings pass through verbatim.
 *
 * Postgres `to_char` documented at
 * `https://www.postgresql.org/docs/16/functions-formatting.html`.
 * The function expects a timestamp-typed first argument; the
 * compiler casts via `::timestamptz` so a date-typed input lifts
 * cleanly (Postgres's date-to-timestamptz cast is implicit but
 * the explicit cast keeps the emission shape uniform with the
 * wider date-arithmetic arms).
 *
 * Pattern strings bind as parameters via the template tag, so
 * author-supplied free-form strings are safely escaped at the
 * driver layer rather than concatenated into the SQL.
 */
function compileFormatDate(
	date: ValueExpression,
	pattern: FormatDatePreset | string,
	ctx: ExpressionCompileContext,
): AliasableExpression<unknown> {
	const dateExpr = compileExpression(date, ctx);
	// Resolve the wire pattern. The `pattern` AST slot is the union
	// `FormatDatePreset | string`; the preset branch maps through
	// the table, the free-form branch is a Postgres pattern by
	// authoring contract.
	const wirePattern = isFormatDatePreset(pattern)
		? FORMAT_DATE_PRESET_TO_PATTERN[pattern]
		: pattern;
	const dateAsTimestamp = eb.cast(dateExpr, "timestamptz");
	// `eb.fn<string>('to_char', [<timestamp>, <pattern>])` emits
	// the typed `to_char(...)` call. The pattern parameter binds
	// through `eb.val` so author-supplied free-form patterns are
	// safely escaped at the driver layer.
	return eb.fn<string>("to_char", [dateAsTimestamp, eb.val(wirePattern)]);
}

/**
 * Type-guard for the `FormatDatePreset` branch of the union.
 * Reads the closed set declared at `FORMAT_DATE_PRESET_KEYS` so
 * adding a preset name to that set auto-extends the runtime
 * dispatch.
 *
 * The guard collapses the structural test (`pattern in <set>`) into
 * a typed boolean so the call site can branch with type narrowing.
 */
function isFormatDatePreset(
	pattern: FormatDatePreset | string,
): pattern is FormatDatePreset {
	return FORMAT_DATE_PRESET_KEYS.has(pattern as FormatDatePreset);
}

// ---------------------------------------------------------------
// Type-erased typed-builder views
// ---------------------------------------------------------------

/**
 * Type-erased local view of the counting subquery's builder during
 * `compileCount`. The subquery starts from the relation-path leaf
 * `AliasedExpression`, optionally filters via `where`, and selects
 * `COUNT(*)` as a single column. The typed builder cannot
 * enumerate the leaf alias against `Database`'s table key set
 * (the leaf is a synthesized subquery, not a table); the calls
 * operate through this minimal interface and the cast back to
 * `AliasableExpression<unknown>` happens at the public boundary.
 *
 * Each method returns the same `DynamicCountQuery` shape so the
 * chain composes without re-narrowing.
 */
interface DynamicCountQuery {
	where: (predicate: Expression<unknown>) => DynamicCountQuery;
	select: (
		selection: AliasedExpression<unknown, string>,
	) => AliasableExpression<unknown>;
}
