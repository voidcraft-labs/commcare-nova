// lib/case-store/sql/compileExpression.ts
//
// Compile a `ValueExpression` to a Kysely expression. Covers all
// every arm of the union (ordinary values plus the operation-local
// `id-of`, `acting-user`, and `unowned` leaves). Term emission delegates to
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
import {
	compileBoundRef,
	compileBoundValue,
	compileTerm,
	type TermCompileContext,
} from "./compileTerm";
import type { Database } from "./database";
import { NAIVE_TEMPORAL_TEXT_PATTERN } from "./dataTypeTokens";

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
		case "id-of":
			return compileBoundRef(
				expr.opUuid,
				ctx.bindings.operationIds,
				`case-operation id '${expr.opUuid}'`,
			);
		case "acting-user":
			return compileBoundValue(ctx.bindings.actingUserId, "the acting user id");
		case "unowned":
			return compileTerm({ kind: "literal", value: "-" }, ctx);
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
						"id-of",
						"acting-user",
						"unowned",
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
 * Parse a temporal operand to an instant with the naive shapes pinned to an
 * explicit zone instead of the Postgres session `TimeZone`.
 *
 * A NAIVE value (calendar date, or date + wall time with no zone designator
 * — see `NAIVE_TEMPORAL_TEXT_PATTERN`) carries no timezone of its own, and a
 * bare `::timestamptz` cast reads it in the connection's current `TimeZone`
 * — which the preview pools do not pin. Naive shapes therefore lift through
 * `timezone(<zone>, <text>::timestamp)`; offset-bearing values keep the
 * ordinary `timestamptz` cast so an authored `Z` or numeric offset remains
 * authoritative.
 *
 * `btrim` accepts a value pasted with harmless surrounding whitespace. The
 * `timestamp` cast in the pinned arm still lets Postgres reject impossible
 * calendar dates rather than normalizing them silently.
 */
function compilePinnedInstant(
	inner: AliasableExpression<unknown>,
	zone: string,
): AliasableExpression<unknown> {
	const trimmedText = eb.fn<string>("btrim", [eb.cast(inner, "text")]);
	const isNaive = eb(trimmedText, "~", eb.val(NAIVE_TEMPORAL_TEXT_PATTERN));
	const pinned = eb.fn<Date>("timezone", [
		eb.val(zone),
		eb.cast(trimmedText, "timestamp"),
	]);
	return eb
		.case()
		.when(isNaive)
		.then(pinned)
		.else(eb.cast(inner, "timestamptz"))
		.end();
}

/**
 * Compile CommCare CSQL's `datetime(...)` coercion. CCHQ resolves naive
 * operands on its UTC servers — `datetime('2021-08-02')` is UTC midnight and
 * `datetime('2021-08-02 20:00:00')` is 20:00 UTC — so every naive shape pins
 * to UTC; explicit offsets win via the `timestamptz` arm.
 */
function compileDatetimeCoerce(
	value: ValueExpression,
	ctx: ExpressionCompileContext,
): AliasableExpression<unknown> {
	return compilePinnedInstant(compileExpression(value, ctx), "UTC");
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
 * IANA `Area/Location` shape — at least one `/`-joined segment. Bare
 * numeric-offset spellings, abbreviations, and single-word names never
 * match.
 */
const IANA_AREA_LOCATION_RE =
	/^[A-Za-z_][A-Za-z0-9_+-]*(?:\/[A-Za-z0-9_+-]+)+$/;

/**
 * Resolve the viewer timezone binding to a zone name safe to hand to
 * Postgres `timezone(...)`. The value is client-supplied; anything but a
 * recognized IANA `Area/Location` name (or literal `UTC`) falls back to
 * UTC — deterministic, never the unpinned session zone.
 *
 * Intl acceptance alone is NOT sufficient: ICU also accepts bare offset
 * spellings like `+05:30`, which Postgres `timezone(...)` reads with the
 * POSIX-inverted sign (5½ hours WEST), silently flipping every rendered
 * time. The shape gate rejects those before the Intl check. A shaped name
 * ICU knows but the server's Postgres tzdata doesn't would still error the
 * query — the two catalogs are independent — but browsers report canonical
 * IANA names, and Postgres tracks the same tzdata releases, so the shape +
 * Intl pair is the practical gate.
 */
function resolveViewerTimeZone(viewerTimeZone: string | undefined): string {
	if (viewerTimeZone === undefined || viewerTimeZone === "UTC") return "UTC";
	if (!IANA_AREA_LOCATION_RE.test(viewerTimeZone)) return "UTC";
	try {
		new Intl.DateTimeFormat("en-US", { timeZone: viewerTimeZone });
		return viewerTimeZone;
	} catch {
		return "UTC";
	}
}

/**
 * `format-date` parses JavaRosa's `%...` vocabulary, then emits one safely
 * bound SQL expression per literal/token run. Passing a JavaRosa pattern
 * straight to Postgres `to_char` is incorrect: the two dialects assign
 * unrelated meanings to ordinary letters, number weekdays differently, and
 * disagree on UTC's offset spelling. Parsing first also lets the compiler
 * reject exactly the same unknown/trailing escapes JavaRosa rejects.
 *
 * Rendering is VIEWER-LOCAL, mirroring the device (JavaRosa formats in the
 * device's zone; in Preview the author's browser stands in for the device)
 * and the sibling client-side formatter
 * (`lib/preview/xpath/dateFormatting.ts`, browser-local) — so a calculated
 * column and a date-kind column show the same wall time on adjacent Preview
 * surfaces. The operand parses through `compilePinnedInstant` in the SAME
 * zone: a naive stored value reads as viewer wall time (what the device does
 * with its local parse), an offset-bearing value keeps its own instant. The
 * instant then converts to a viewer wall-clock `timestamp` that
 * `to_char` / `date_part` render zone-independently.
 *
 * A null guard preserves the former `to_char(NULL, ...) → NULL` behavior;
 * Postgres `concat` would otherwise skip a null token and leave any
 * surrounding authored literals visible.
 */
function compileFormatDate(
	date: ValueExpression,
	pattern: FormatDatePreset | string,
	ctx: ExpressionCompileContext,
): AliasableExpression<unknown> {
	const zone = resolveViewerTimeZone(ctx.bindings.viewerTimeZone);
	const dateExpr = compileExpression(date, ctx);
	const instant = compilePinnedInstant(dateExpr, zone);
	const wallClock = eb.fn<Date>("timezone", [eb.val(zone), instant]);
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
			: compileCommCareDateToken(wallClock, instant, zone, segment.token),
	);
	const formatted =
		parts.length === 0 ? sqlTextValue("") : eb.fn<string>("concat", parts);
	return eb
		.case()
		.when(eb(instant, "is", null))
		.then(eb.cast(eb.val(null), "text"))
		.else(formatted)
		.end();
}

/**
 * Compile one JavaRosa token without exposing its pattern to Postgres.
 * `wallClock` is the viewer-zone `timestamp` every wall-clock token
 * renders from; `instant` + `zone` exist only for `%Z`, which needs the
 * zone's UTC offset AT that instant (a `timestamp` has no offset left to
 * read).
 */
function compileCommCareDateToken(
	wallClock: AliasableExpression<unknown>,
	instant: AliasableExpression<unknown>,
	zone: string,
	token: CommCareDateFormatToken,
): AliasableExpression<unknown> {
	const toChar = (postgresPattern: string) =>
		eb.fn<string>("to_char", [wallClock, sqlTextValue(postgresPattern)]);
	const datePart = (part: "month" | "dow") =>
		eb.cast(eb.fn<number>("date_part", [eb.val(part), wallClock]), "integer");

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
		case "Z":
			return compileTimezoneOffsetToken(instant, zone);
	}
}

/**
 * `%Z` — the viewer zone's UTC offset at the formatted instant, in
 * JavaRosa's exact shape (`commcare-core
 * DateUtils.getOffsetInStandardFormat`, mirrored by the client formatter at
 * `dateFormatting.ts::formatTimezoneOffset`). The shape keys on the HOURS
 * field, not the total offset: `Z` whenever the truncated hour count is
 * zero — a ±30-minute offset renders `Z:30`, sign dropped — else `±HH`,
 * with `:MM` appended whenever the minute remainder is nonzero.
 * `to_char(..., 'OF')` can't produce this — it reads the SESSION zone's
 * offset, and the viewer-zone `timestamp` the other tokens render from has
 * no offset left to read — so the offset is computed as minutes between
 * the zone's wall clock and UTC's at the instant. Postgres integer
 * division truncates toward zero, matching Java's, so the hour count
 * agrees for negative sub-hour offsets.
 */
function compileTimezoneOffsetToken(
	instant: AliasableExpression<unknown>,
	zone: string,
): AliasableExpression<unknown> {
	const minutes = eb.cast(
		eb(
			eb.fn<number>("date_part", [
				eb.val("epoch"),
				eb(
					eb.fn<Date>("timezone", [eb.val(zone), instant]),
					"-",
					eb.fn<Date>("timezone", [eb.val("UTC"), instant]),
				),
			]),
			"/",
			eb.val(60),
		),
		"integer",
	);
	const twoDigit = (value: AliasableExpression<unknown>) =>
		eb.fn<string>("lpad", [
			eb.cast(value, "text"),
			eb.val(2),
			sqlTextValue("0"),
		]);
	const hours = eb(minutes, "/", eb.val(60));
	const head = eb
		.case()
		.when(eb(hours as Expression<number>, ">", eb.val(0)))
		.then(eb.fn<string>("concat", [sqlTextValue("+"), twoDigit(hours)]))
		.when(eb(hours as Expression<number>, "=", eb.val(0)))
		.then(sqlTextValue("Z"))
		.else(
			eb.fn<string>("concat", [
				sqlTextValue("-"),
				twoDigit(eb.fn<number>("abs", [hours])),
			]),
		)
		.end();
	const remainder = eb(eb.fn<number>("abs", [minutes]), "%", eb.val(60));
	const minutesSuffix = eb
		.case()
		.when(eb(remainder as Expression<number>, "=", eb.val(0)))
		.then(sqlTextValue(""))
		.else(eb.fn<string>("concat", [sqlTextValue(":"), twoDigit(remainder)]))
		.end();
	return eb.fn<string>("concat", [head, minutesSuffix]);
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
