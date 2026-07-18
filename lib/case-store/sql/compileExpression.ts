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
import type { CaseType } from "@/lib/domain/blueprint";
import {
	COMMCARE_DATE_FORMAT_TOKENS,
	COMMCARE_DAY_NAMES_LONG,
	COMMCARE_DAY_NAMES_SHORT,
	COMMCARE_MONTH_NAMES_LONG,
	COMMCARE_MONTH_NAMES_SHORT,
	type CommCareDateFormatToken,
	parseCommCareDatePattern,
} from "@/lib/domain/commCareDatePattern";
import { resolveCommCareDatePattern } from "@/lib/domain/dateFormats";
import {
	missingPredicateThunkMessage,
	typeCheckerBypassMessage,
	unhandledKindMessage,
} from "@/lib/domain/predicate/errors";
import { canonicalizeRelationPath } from "@/lib/domain/predicate/normalizeRelationEvaluationScopes";
import {
	asTemporalType,
	inferStructuralTemporalType,
	type TemporalType,
} from "@/lib/domain/predicate/temporalType";
import {
	type CheckError,
	checkExpression,
} from "@/lib/domain/predicate/typeChecker";
import type {
	ArithOp,
	DateAddInterval,
	FormatDatePreset,
	Predicate,
	RelationPath,
	SwitchCase,
	ValueExpression,
} from "@/lib/domain/predicate/types";
import {
	STANDARD_CASE_LIST_PROPERTY_DATA_TYPES,
	standardCasePropertyDisplayLabel,
} from "@/lib/domain/standardCaseProperties";
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
			return compileDatetimeCoerce(expr.value, ctx);
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

/** Postgres cast wrapper for `date-coerce` / `double`. */
function compileCast(
	value: ValueExpression,
	cast: "date" | "timestamptz" | "numeric",
	ctx: ExpressionCompileContext,
): AliasableExpression<unknown> {
	const inner = compileExpression(value, ctx);
	return eb.cast(inner, cast);
}

/**
 * Compile CommCare CSQL's `datetime(...)` coercion without inheriting the
 * Postgres session timezone for a calendar-date operand.
 *
 * CCHQ defines `datetime('2021-08-02')` as UTC midnight. A plain Postgres
 * `'2021-08-02'::timestamptz`, however, means midnight in the connection's
 * current `TimeZone`. Preview pools do not pin that setting, so the bare cast
 * shifted Nova's exact-day and date-range boundaries whenever a session was
 * non-UTC. Detect the one lexical shape whose timezone CSQL supplies and lift
 * it through `timestamp AT TIME ZONE 'UTC'`. Full datetime strings keep the
 * ordinary `timestamptz` cast so an authored `Z` or numeric offset remains
 * authoritative.
 *
 * `btrim` accepts a value pasted with harmless surrounding whitespace. The
 * date cast in the UTC arm still lets Postgres reject impossible calendar
 * dates rather than normalizing them silently.
 */
function compileDatetimeCoerce(
	value: ValueExpression,
	ctx: ExpressionCompileContext,
): AliasableExpression<unknown> {
	const inner = compileExpression(value, ctx);
	const trimmedText = eb.fn<string>("btrim", [eb.cast(inner, "text")]);
	const isCalendarDate = eb(
		trimmedText,
		"~",
		eb.val("^[0-9]{4}-[0-9]{2}-[0-9]{2}$"),
	);
	const utcMidnight = eb.fn<Date>("timezone", [
		eb.val("UTC"),
		eb.cast(trimmedText, "timestamp"),
	]);
	return eb
		.case()
		.when(isCalendarDate)
		.then(utcMidnight)
		.else(eb.cast(inner, "timestamptz"))
		.end();
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
 * `date-add` preserves the authored base's temporal type:
 *
 * - date → `cast(cast(<date> as date) + make_interval(...) as date)`
 * - datetime → `cast(<date> as timestamptz) + make_interval(...)`
 *
 * CCHQ's `date-add` returns a date while `datetime-add` retains the timestamp.
 * Keeping that distinction here is load-bearing for SQL / Preview / wire
 * parity, especially when a sub-day or fractional interval crosses midnight.
 */
function compileDateAdd(
	date: ValueExpression,
	interval: DateAddInterval,
	quantity: ValueExpression,
	ctx: ExpressionCompileContext,
): AliasableExpression<unknown> {
	const baseType = resolveDateAddBaseType(date, ctx);
	const dateExpr = compileExpression(date, ctx);
	const quantityExpr = compileExpression(quantity, ctx);
	const intervalExpr = makeIntervalForUnit(interval, quantityExpr);
	if (baseType === "date") {
		const shiftedDate = eb(eb.cast(dateExpr, "date"), "+", intervalExpr);
		return eb.cast(shiftedDate, "date");
	}
	return eb(eb.cast(dateExpr, "timestamptz"), "+", intervalExpr);
}

/**
 * Resolve the semantic type that `date-add` inherits from its date operand.
 * Context-free discriminators and explicit coercions take the cheap path;
 * property reads and wrapper expressions route through the canonical domain
 * type checker. The case-store schema map intentionally excludes implicit
 * standard properties because those compile from scalar columns, so this
 * type-check-only projection restores them without changing SQL reads.
 */
function resolveDateAddBaseType(
	date: ValueExpression,
	ctx: ExpressionCompileContext,
): TemporalType {
	const structural = inferStructuralTemporalType(date);
	if (structural === "date" || structural === "datetime") return structural;

	const errors: CheckError[] = [];
	const resolved = checkExpression(
		date,
		{
			caseTypes: caseTypesForTemporalTypeChecking(ctx.caseTypeSchemas),
			knownInputs: [],
		},
		errors,
		[],
	);
	const temporal = asTemporalType(resolved);
	if (errors.length === 0 && temporal !== undefined) return temporal;

	throw new Error(
		typeCheckerBypassMessage({
			where: "compileExpression.compileDateAdd",
			summary:
				"`date-add` reached SQL emission without a resolvable date-or-datetime base type",
			expected:
				"the canonical predicate type checker resolves the date operand to `date` or `datetime` before SQL compilation",
			received:
				errors.length > 0
					? errors.map((error) => error.message).join("; ")
					: `resolved type ${String(resolved)}`,
			hint: "Preserve the operand's declared type through runtime binding, or author an explicit date/datetime coercion; SQL must not guess from a property name or string value.",
		}),
	);
}

function caseTypesForTemporalTypeChecking(
	schemas: ReadonlyMap<string, CaseType>,
): CaseType[] {
	return [...schemas.values()].map((caseType) => {
		const declared = new Set(
			caseType.properties.map((property) => property.name),
		);
		const standardProperties = Object.entries(
			STANDARD_CASE_LIST_PROPERTY_DATA_TYPES,
		)
			.filter(([name]) => !declared.has(name))
			.map(([name, data_type]) => ({
				name,
				label: standardCasePropertyDisplayLabel(name),
				data_type,
			}));
		return standardProperties.length === 0
			? caseType
			: {
					...caseType,
					properties: [...caseType.properties, ...standardProperties],
				};
	});
}

/**
 * Build an interval for one AST unit. Fixed-duration units use a one-unit
 * `make_interval(...)` multiplied by the quantity as `float8`: Postgres's
 * positional `weeks` / `days` / `hours` / `mins` arguments are integers, but
 * Nova and CCHQ both admit fractional fixed durations. Calendar-relative
 * months / years keep the direct positional call because CCHQ likewise
 * requires an integral count for those ambiguous units.
 *
 * - `days, q` → `make_interval(0, 0, 0, 1) * cast(q as float8)`
 * - `seconds, q` → `make_interval(0, 0, 0, 0, 0, 0, 1) * cast(q as float8)`
 * - `years, q` → `make_interval(<whole-number guard>(q))`
 *
 * CCHQ accepts integral decimal spellings such as `"1.0"` for calendar units
 * but rejects non-integral values as ambiguous. Postgres's `make_interval`
 * calendar slots accept only integers, and a direct numeric→integer cast would
 * silently round `1.5`. `calendarQuantityAsInteger` therefore checks
 * `q = trunc(q)` before casting and deliberately raises a Postgres cast error
 * on the invalid branch. The SQL boundary enforces the same runtime contract
 * even when the quantity came from a dynamic search-input binding.
 */
function makeIntervalForUnit(
	unit: DateAddInterval,
	quantityExpr: AliasableExpression<unknown>,
): AliasableExpression<unknown> {
	const slot = DATE_ADD_INTERVAL_SLOT_INDEX[unit];
	const args: AliasableExpression<unknown>[] = [];
	for (let i = 0; i <= slot; i++) {
		args.push(
			i === slot && (unit === "months" || unit === "years")
				? calendarQuantityAsInteger(quantityExpr)
				: eb.val(i === slot ? 1 : 0),
		);
	}
	const interval = eb.fn("make_interval", args);
	return unit === "months" || unit === "years"
		? interval
		: eb(interval, "*", eb.cast(quantityExpr, "float8"));
}

/**
 * Adapt a numeric calendar quantity to `make_interval`'s integer slot without
 * rounding. The invalid branch depends on the runtime value, so Postgres only
 * evaluates its intentionally invalid text→integer cast when the quantity has
 * a fractional component. This stays entirely on Kysely's typed expression
 * surface; no raw SQL or string interpolation reaches the query.
 */
function calendarQuantityAsInteger(
	quantityExpr: AliasableExpression<unknown>,
): AliasableExpression<unknown> {
	const numeric = eb.cast(quantityExpr, "numeric");
	const truncated = eb.fn("trunc", [numeric]);
	const invalid = eb.cast(
		eb.fn("concat", [
			numeric,
			eb.cast(eb.val(" is not a whole month-or-year quantity"), "text"),
		]),
		"integer",
	);
	return eb
		.case()
		.when(eb(numeric, "=", truncated))
		.then(eb.cast(numeric, "integer"))
		.else(invalid)
		.end();
}

/**
 * `concat(parts)`. NULL parts are ignored (Postgres docs §
 * "String Functions" — observably identical to coercing NULL to
 * empty). Chosen over `||` (which propagates NULL) because the
 * AST's `concat` semantic is "each part casts to text at
 * evaluation"; `||` would need `COALESCE(part, '')` at every part.
 *
 * Cast every part explicitly rather than relying on Postgres's variadic
 * `concat(any...)` coercion. A freshly-authored Combined text expression is
 * valid with one blank literal part; Kysely binds that literal as a prepared
 * parameter, and `concat($1)` gives Postgres no type context for `$1`
 * (`42P18: could not determine data type of parameter`). The explicit casts
 * are both the AST's declared semantics and the type context every arity needs.
 */
function compileConcat(
	parts: ReadonlyArray<ValueExpression>,
	ctx: ExpressionCompileContext,
): AliasableExpression<unknown> {
	const partExprs = parts.map((p) =>
		eb.cast(compileExpression(p, ctx), "text"),
	);
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
 * every row reaching it is already tenant-scoped. `count(self)` is the
 * cardinality of the current row: `1` without a filter, or `CASE WHEN where
 * THEN 1 ELSE 0 END` with one. This mirrors the on-device emitter rather than
 * routing a self path through a redundant relation subquery.
 */
function compileCount(
	via: RelationPath,
	where: Predicate | undefined,
	ctx: ExpressionCompileContext,
): AliasableExpression<unknown> {
	const relation = canonicalizeRelationPath(via, {
		caseTypes: [...ctx.caseTypeSchemas.values()],
		...(ctx.currentCaseType === undefined
			? {}
			: { currentCaseType: ctx.currentCaseType }),
	});
	if (relation.via.kind === "self") {
		if (where === undefined) return eb.lit(1);
		const compilePredicate = ctx.compilePredicate;
		if (compilePredicate === undefined) {
			throw new Error(
				missingPredicateThunkMessage({
					where: "compileExpression",
					arm: "count(via=self, where)",
					slot: "`count(via=self, where)`'s `where` clause is a `Predicate`",
				}),
			);
		}
		return eb
			.case()
			.when(compilePredicate(where, ctx) as Expression<boolean>)
			.then(eb.lit(1))
			.else(eb.lit(0))
			.end();
	}
	const compiledPath = compileRelationPath(relation.via, {
		db: ctx.db,
		appId: ctx.appId,
		projectId: ctx.projectId,
		anchorAlias: ctx.anchorAlias,
		relationPathDepth: ctx.relationPathDepth ?? 0,
	});
	if (compiledPath.kind === "self") {
		throw new Error(
			"compileExpression.compileCount: canonical non-self relation unexpectedly compiled as self",
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
		...(relation.destinationCaseType === undefined
			? {}
			: { currentCaseType: relation.destinationCaseType }),
	});
	return baseQuery
		.where(whereExpr)
		.select(
			eb.fn.countAll().as("n"),
		) as unknown as AliasableExpression<unknown>;
}

/**
 * `format-date` parses JavaRosa's `%...` vocabulary, then emits one safely
 * bound SQL expression per literal/token run. Passing a JavaRosa pattern
 * straight to Postgres `to_char` is incorrect: the two dialects assign
 * unrelated meanings to ordinary letters, number weekdays differently, and
 * disagree on UTC's offset spelling. Parsing first also lets the compiler
 * reject exactly the same unknown/trailing escapes JavaRosa rejects.
 *
 * The explicit `::timestamptz` cast keeps the emission shape uniform with the
 * wider date-arithmetic arms. A null guard preserves the former `to_char(NULL,
 * ...) → NULL` behavior; Postgres `concat` would otherwise skip a null token
 * and leave any surrounding authored literals visible.
 */
function compileFormatDate(
	date: ValueExpression,
	pattern: FormatDatePreset | string,
	ctx: ExpressionCompileContext,
): AliasableExpression<unknown> {
	const dateExpr = compileExpression(date, ctx);
	const dateAsTimestamp = eb.cast(dateExpr, "timestamptz");
	const wirePattern = resolveCommCareDatePattern(pattern);
	const parsed = parseCommCareDatePattern(wirePattern);
	if (parsed.kind === "unsupported-pattern") {
		const problem = parsed.escape ?? "a trailing %";
		throw new Error(
			`compileExpression: format-date pattern contains ${problem}; supported escapes are ${COMMCARE_DATE_FORMAT_TOKENS.map((token) => `%${token}`).join(", ")}`,
		);
	}

	const parts = parsed.segments.map((segment) =>
		segment.kind === "literal"
			? sqlTextValue(segment.text)
			: compileCommCareDateToken(dateAsTimestamp, segment.token),
	);
	const formatted =
		parts.length === 0 ? sqlTextValue("") : eb.fn<string>("concat", parts);
	return eb
		.case()
		.when(eb(dateAsTimestamp, "is", null))
		.then(eb.cast(eb.val(null), "text"))
		.else(formatted)
		.end();
}

/** Compile one JavaRosa token without exposing its pattern to Postgres. */
function compileCommCareDateToken(
	date: AliasableExpression<unknown>,
	token: CommCareDateFormatToken,
): AliasableExpression<unknown> {
	const toChar = (postgresPattern: string) =>
		eb.fn<string>("to_char", [date, sqlTextValue(postgresPattern)]);
	const datePart = (part: "month" | "dow") =>
		eb.cast(eb.fn<number>("date_part", [eb.val(part), date]), "integer");

	switch (token) {
		case "%":
			return sqlTextValue("%");
		case "Y":
			return toChar("YYYY");
		case "y":
			return toChar("YY");
		case "m":
			return toChar("MM");
		case "n":
			return toChar("FMMM");
		case "B":
			return compileIndexedDateName(
				datePart("month"),
				COMMCARE_MONTH_NAMES_LONG,
				1,
			);
		case "b":
			return compileIndexedDateName(
				datePart("month"),
				COMMCARE_MONTH_NAMES_SHORT,
				1,
			);
		case "d":
			return toChar("DD");
		case "e":
			return toChar("FMDD");
		case "H":
			return toChar("HH24");
		case "h":
			return toChar("FMHH24");
		case "M":
			return toChar("MI");
		case "S":
			return toChar("SS");
		case "3":
			return toChar("MS");
		case "A":
			return compileIndexedDateName(
				datePart("dow"),
				COMMCARE_DAY_NAMES_LONG,
				0,
			);
		case "a":
			return compileIndexedDateName(
				datePart("dow"),
				COMMCARE_DAY_NAMES_SHORT,
				0,
			);
		case "w":
			return eb.cast(datePart("dow"), "text");
		case "Z": {
			// Postgres `OF` already matches JavaRosa's +HH / +HH:MM shape;
			// only UTC differs (`+00` versus JavaRosa's `Z`).
			const offset = toChar("OF");
			return eb
				.case()
				.when(
					eb(
						offset as Expression<string>,
						"=",
						sqlTextValue("+00") as Expression<string>,
					),
				)
				.then(sqlTextValue("Z"))
				.else(offset)
				.end();
		}
	}
}

/**
 * Month/day names are pinned to JavaRosa's English defaults with a CASE over
 * the numeric calendar field. Postgres's `Month` / `Day` tokens depend on
 * `lc_time`, so using them would reintroduce environment-dependent drift.
 */
function compileIndexedDateName(
	index: AliasableExpression<unknown>,
	names: readonly string[],
	firstIndex: number,
): AliasableExpression<unknown> {
	let builder = eb.case(index as Expression<unknown>);
	for (const [offset, name] of names.entries()) {
		builder = builder
			.when(eb.val(firstIndex + offset))
			.then(sqlTextValue(name)) as unknown as typeof builder;
	}
	return (
		builder as unknown as {
			else: (value: AliasableExpression<unknown>) => {
				end: () => AliasableExpression<unknown>;
			};
		}
	)
		.else(sqlTextValue(""))
		.end();
}

/** Postgres cannot infer `unknown` parameters passed to variadic `concat`. */
function sqlTextValue(value: string): AliasableExpression<unknown> {
	return eb.cast(eb.val(value), "text");
}

/** Builder shape for the counting subquery in `compileCount`. */
interface DynamicCountQuery {
	where: (predicate: Expression<unknown>) => DynamicCountQuery;
	select: (
		selection: AliasedExpression<unknown, string>,
	) => AliasableExpression<unknown>;
}
