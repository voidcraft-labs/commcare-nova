// lib/case-store/sql/compileExpression.ts
//
// Compile a `ValueExpression` to a Kysely expression. Covers all
// 15 arms of the union (term / today / now / cast arms / arith /
// concat / coalesce / if / switch / count / format-date / date-add
// / unwrap-list defensive throw). Term emission delegates to
// `./compileTerm`; relation-path subqueries delegate to
// `./compileRelationPath`.
//
// ## Predicate-thunk strategy
//
// Two arms (`if.cond`, `count.where`) carry `Predicate` operands.
// The Expression compiler doesn't import the Predicate compiler
// directly — `ExpressionCompileContext` carries a callback the
// integrating caller supplies. This keeps the two compilers
// structurally independent so the predicate compiler can recurse
// back into the expression compiler without an import cycle.
//
// The `switch` arm does NOT need the thunk — every `cases[].when`
// is a `Literal` per `switchCaseSchema`, not a Predicate. The
// expression compiler handles the equality dispatch directly.
//
// ## Why simple `CASE` (not searched) for `switch`
//
// SQL's simple `case <on> when <lit> then ...` evaluates the
// discriminator ONCE per row and compares cached. The searched
// form `case when <on> = <lit> then ...` re-evaluates per branch;
// Postgres's planner does not deduplicate non-idempotent operands
// across CASE arms, so a `count(...)` discriminator would scan
// its relation-walk leaf N times.

import type {
	AliasableExpression,
	AliasedExpression,
	BinaryOperator,
	Expression,
} from "kysely";
import { expressionBuilder } from "kysely";
import {
	missingPredicateThunkMessage,
	typeCheckerBypassMessage,
	unhandledKindMessage,
} from "@/lib/domain/predicate/errors";
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
 * Predicate-compilation callback for the `if.cond` / `count.where`
 * arms. The integrating caller supplies the real predicate
 * compiler; tests inject stubs.
 */
export type CompilePredicateThunk = (
	predicate: Predicate,
	ctx: ExpressionCompileContext,
) => Expression<unknown>;

/**
 * Extends `TermCompileContext` (every arm delegates to the term
 * compiler for property reads etc.) plus an optional
 * `compilePredicate` thunk for the predicate-bearing arms.
 * Optional at the type layer; arms that reach a missing callback
 * throw.
 */
export interface ExpressionCompileContext extends TermCompileContext {
	compilePredicate?: CompilePredicateThunk;
}

// ---------------------------------------------------------------
// AST-op → SQL-token mappings
// ---------------------------------------------------------------

/**
 * `ARITH_OPS` → Postgres operator tokens. `div` / `mod` use the
 * CCHQ spelled-out names because XPath's `/` is a path separator
 * and `%` has no XPath meaning; Postgres uses the standard `/` and
 * `%` for integer division / modulo.
 */
const ARITH_OP_TO_SQL: Readonly<Record<ArithOp, BinaryOperator>> = {
	"+": "+",
	"-": "-",
	"*": "*",
	div: "/",
	mod: "%",
};

/**
 * Postgres `to_char` patterns per preset. The `FM` prefix on
 * `Month` matters — bare `Month` returns a fixed-width 9-char
 * string ("May      "); `FM` strips the padding at the renderer.
 */
const FORMAT_DATE_PRESET_TO_PATTERN: Readonly<
	Record<FormatDatePreset, string>
> = {
	short: "MM/DD/YYYY",
	long: "FMMonth FMDD, YYYY",
	iso: "YYYY-MM-DD",
};

/**
 * Preset name set, derived from the typed Record so adding a
 * preset auto-extends the runtime dispatch. A hand-maintained
 * sibling set would silently miss a new preset (TypeScript
 * wouldn't catch the divergence — the new key is still a valid
 * `FormatDatePreset`).
 */
const FORMAT_DATE_PRESET_KEYS: ReadonlySet<FormatDatePreset> = new Set(
	Object.keys(FORMAT_DATE_PRESET_TO_PATTERN) as FormatDatePreset[],
);

// ---------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------

/** Compile a `ValueExpression` to a Kysely expression. */
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
				typeCheckerBypassMessage({
					where: "compileExpression",
					summary:
						"`unwrap-list` reached the SQL compiler, but no Postgres-side AST consumer accepts a sequence value",
					expected:
						"the type checker rejects `unwrap-list` outside the CSQL wire emitter (the AST resolves it to the `_sequence` sentinel and every Predicate / Expression arm requires a non-sequence operand)",
					received: "an `unwrap-list` expression as a value-bearing operand",
					hint: "the CSQL wire emitter is the only consumer of `unwrap-list` (via the `selected-any(prop, unwrap-list(...))` pattern). SQL-side authoring surfaces must reject sequence-typed expressions before they reach `compileExpression`.",
				}),
			);
		case "format-date":
			return compileFormatDate(expr.date, expr.pattern, ctx);
		default: {
			const _exhaustive: never = expr;
			throw new Error(
				unhandledKindMessage({
					where: "compileExpression",
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

/** Module-scoped expression builder. */
const eb = expressionBuilder<Database, keyof Database>();

/**
 * `today` → `cast(now() as date)`. `now()::date` is transaction-
 * stable equivalent to `current_date` per
 * `https://www.postgresql.org/docs/18/functions-datetime.html#FUNCTIONS-DATETIME-CURRENT`.
 * `current_date` is a niladic SQL keyword Kysely's `eb.fn` cannot
 * emit (the function module always wraps the name in parens).
 */
function compileToday(): AliasableExpression<unknown> {
	return eb.cast(eb.fn<Date>("now"), "date");
}

function compileNow(): AliasableExpression<unknown> {
	return eb.fn<Date>("now");
}

/** Postgres cast wrapper for `date-coerce` / `datetime-coerce` / `double`. */
function compileCast(
	value: ValueExpression,
	cast: "date" | "timestamptz" | "numeric",
	ctx: ExpressionCompileContext,
): AliasableExpression<unknown> {
	const inner = compileExpression(value, ctx);
	return eb.cast(inner, cast);
}

/**
 * Compile `arith` to `<left> <op> <right>`. Each side paren-wraps
 * uniformly so nested `arith` honors AST left-to-right associativity
 * rather than Postgres operator precedence; mixing precedence-aware
 * emission with paren-wrapping would surface arithmetic-priority
 * bugs only at runtime.
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
	return eb(leftExpr, opToken, rightExpr);
}

/**
 * Positional slot per `DateAddInterval` arm in Postgres's
 * `make_interval(years, months, weeks, days, hours, mins, secs)`.
 */
const DATE_ADD_INTERVAL_SLOT_INDEX: Readonly<Record<DateAddInterval, number>> =
	{
		years: 0,
		months: 1,
		weeks: 2,
		days: 3,
		hours: 4,
		minutes: 5,
		seconds: 6,
	};

/**
 * `date-add` → `cast(<date> as timestamptz) + make_interval(...)`.
 * The base casts to `timestamptz` so date-typed and datetime-typed
 * inputs both lift to the same return type.
 */
function compileDateAdd(
	date: ValueExpression,
	interval: DateAddInterval,
	quantity: ValueExpression,
	ctx: ExpressionCompileContext,
): AliasableExpression<unknown> {
	const dateExpr = compileExpression(date, ctx);
	const quantityExpr = compileExpression(quantity, ctx);
	const dateAsTimestamp = eb.cast(dateExpr, "timestamptz");
	const intervalExpr = makeIntervalForUnit(interval, quantityExpr);
	return eb(dateAsTimestamp, "+", intervalExpr);
}

/**
 * `make_interval(...)` with `quantityExpr` at the positional slot
 * for `unit`, zero-padded through preceding slots. Trailing slots
 * omitted — Postgres applies its documented zero defaults.
 *
 * - `days, 7` → `make_interval(0, 0, 0, 7)`
 * - `seconds, q` → `make_interval(0, 0, 0, 0, 0, 0, q)`
 * - `years, q` → `make_interval(q)`
 */
function makeIntervalForUnit(
	unit: DateAddInterval,
	quantityExpr: AliasableExpression<unknown>,
): AliasableExpression<unknown> {
	const slot = DATE_ADD_INTERVAL_SLOT_INDEX[unit];
	const args: AliasableExpression<unknown>[] = [];
	for (let i = 0; i <= slot; i++) {
		args.push(i === slot ? quantityExpr : eb.val(0));
	}
	return eb.fn("make_interval", args);
}

/**
 * `concat(parts)`. NULL parts are ignored (Postgres docs §
 * "String Functions" — observably identical to coercing NULL to
 * empty). Chosen over `||` (which propagates NULL) because the
 * AST's `concat` semantic is "each part casts to text at
 * evaluation"; `||` would need `COALESCE(part, '')` at every part.
 */
function compileConcat(
	parts: ReadonlyArray<ValueExpression>,
	ctx: ExpressionCompileContext,
): AliasableExpression<unknown> {
	const partExprs = parts.map((p) => compileExpression(p, ctx));
	return eb.fn<string>("concat", partExprs);
}

/**
 * `coalesce(values)` → SQL `COALESCE(...)`. Empty-string-as-null
 * coercion lives at the AST layer (the validator hints on
 * `eq(prop, "")`); a JSONB-absent read returns SQL `NULL`, and
 * `COALESCE` correctly skips to the next argument.
 */
function compileCoalesce(
	values: ReadonlyArray<ValueExpression>,
	ctx: ExpressionCompileContext,
): AliasableExpression<unknown> {
	const valueExprs = values.map((v) => compileExpression(v, ctx));
	// Kysely's typed `eb.fn.coalesce` is positional-args (up to
	// five); the generic `eb.fn` form takes an array and works for
	// any arity, matching the AST's open-ended `values` list.
	return eb.fn<unknown>("coalesce", valueExprs);
}

/**
 * `if` → `CASE WHEN <cond> THEN <then> ELSE <else> END`. `cond`
 * routes through the `compilePredicate` thunk (the cycle break);
 * an absent thunk is a caller-setup error and throws.
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
			missingPredicateThunkMessage({
				where: "compileExpression",
				arm: "if",
				slot: "`if` arm carries a `Predicate` condition",
			}),
		);
	}
	const condExpr = compilePredicate(cond, ctx);
	const thenExpr = compileExpression(thenBranch, ctx);
	const elseExpr = compileExpression(elseBranch, ctx);
	// Passing typed expressions (not raw values) to `.then` /
	// `.else` keeps the parameter channel consistent — Kysely
	// otherwise inlines numbers / booleans / null directly into the
	// SQL, which would shift the parameter list cold tests pin.
	return eb
		.case()
		.when(condExpr as Expression<boolean>)
		.then(thenExpr)
		.else(elseExpr)
		.end();
}

/** Compile `switch` to SQL's simple-CASE form. See file header for "why simple". */
function compileSwitch(
	on: ValueExpression,
	cases: ReadonlyArray<SwitchCase>,
	fallback: ValueExpression,
	ctx: ExpressionCompileContext,
): AliasableExpression<unknown> {
	const onExpr: Expression<unknown> = compileExpression(on, ctx);
	const fallbackExpr = compileExpression(fallback, ctx);
	// `as unknown as` per-iteration widens because TS can't
	// enumerate the fluent chain's `O` accumulation.
	let builder = eb.case(onExpr);
	for (const c of cases) {
		const whenExpr = compileExpression({ kind: "term", term: c.when }, ctx);
		const thenExpr = compileExpression(c.then, ctx);
		builder = builder
			.when(whenExpr)
			.then(thenExpr) as unknown as typeof builder;
	}
	return (
		builder as unknown as {
			else: (e: AliasableExpression<unknown>) => {
				end: () => AliasableExpression<unknown>;
			};
		}
	)
		.else(fallbackExpr)
		.end();
}

/**
 * `count(via, where?)` → `(SELECT COUNT(*) FROM <rp_leaf> [WHERE
 * <where-pred>])`. Tenant filtering lives in `compileRelationPath`;
 * the outer `COUNT(*)` doesn't need a separate filter because
 * every row reaching it is already tenant-scoped. `count(self)`
 * is rejected at the type-checker layer
 * (`lib/domain/predicate/typeChecker.ts::checkRelationalQuantifier`);
 * reaching `self` here is a type-checker bypass.
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
			typeCheckerBypassMessage({
				where: "compileExpression.compileCount",
				summary:
					"`count(self)` reached the SQL compiler, but the type checker rejects `self` as the via of a relational quantifier",
				expected:
					"a `RelationPath` whose `kind` is `ancestor`, `subcase`, or `any-relation` (see `checkRelationalQuantifier` in `lib/domain/predicate/typeChecker.ts`)",
				received: '`{ kind: "self" }`',
				hint: "the relational quantifiers (`exists` / `missing` / `count`) only make sense over a non-trivial relation walk. If you intended to count something on the anchor row, use a different aggregation surface; otherwise, replace the via with the relation walk you intend to count.",
			}),
		);
	}
	// Type-erased via `DynamicCountQuery` — runtime leaf alias.
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
			missingPredicateThunkMessage({
				where: "compileExpression",
				arm: "count(via, where)",
				slot: "`count(via, where)`'s `where` clause is a `Predicate`",
			}),
		);
	}
	// `anchorAlias` swap + depth bump — same pattern as
	// `compileExistsOrMissing`.
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

/**
 * `format-date` → Postgres `to_char(<timestamptz>, '<pattern>')`.
 * The explicit `::timestamptz` cast keeps the emission shape
 * uniform with the wider date-arithmetic arms (date-to-timestamptz
 * is implicit, but explicit at the boundary is clearer).
 */
function compileFormatDate(
	date: ValueExpression,
	pattern: FormatDatePreset | string,
	ctx: ExpressionCompileContext,
): AliasableExpression<unknown> {
	const dateExpr = compileExpression(date, ctx);
	const wirePattern = isFormatDatePreset(pattern)
		? FORMAT_DATE_PRESET_TO_PATTERN[pattern]
		: pattern;
	const dateAsTimestamp = eb.cast(dateExpr, "timestamptz");
	// `eb.val(wirePattern)` binds via parameter so author-supplied
	// free-form patterns are safely escaped at the driver layer.
	return eb.fn<string>("to_char", [dateAsTimestamp, eb.val(wirePattern)]);
}

function isFormatDatePreset(
	pattern: FormatDatePreset | string,
): pattern is FormatDatePreset {
	return FORMAT_DATE_PRESET_KEYS.has(pattern as FormatDatePreset);
}

/** Builder shape for the counting subquery in `compileCount`. */
interface DynamicCountQuery {
	where: (predicate: Expression<unknown>) => DynamicCountQuery;
	select: (
		selection: AliasedExpression<unknown, string>,
	) => AliasableExpression<unknown>;
}
