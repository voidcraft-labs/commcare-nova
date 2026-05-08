// lib/case-store/sql/compilePredicate.ts
//
// Compile a `Predicate` to an `Expression<SqlBool>` the case-list
// query layer feeds into `where(...)`. Per-arm dispatch over the
// `Predicate` discriminated union; term emission delegates to
// `./compileTerm`; relation-path subqueries delegate to
// `./compileRelationPath`.
//
// Operand dispatch routes every `ValueExpression` slot through one
// helper (`compileValueExprOperand`) — term arm → `compileTerm`;
// every other arm → `compileExpression` with a thunk-wired
// callback. The cycle break is the runtime callback; neither
// compiler imports the other through a value-position edge.
//
// ## Relation-path strategy: correlated EXISTS, not side-channel
//
// `exists` / `missing` compile to correlated `EXISTS (subquery)` /
// `NOT EXISTS (...)` against the relation-path leaf. The
// correlation is `<leaf>.anchor_case_id = <ctx.anchorAlias>.case_id`.
// The compiled predicate is a single self-contained boolean
// expression — no "joins to register" side channel.
//
// The inner `where`'s context swaps `anchorAlias` to the leaf
// alias for the recursive call. A self-via term inside the inner
// `where` semantically means "on the related case", not "on the
// anchor"; the swap pins that intent. The depth counter increments
// so a nested `compileRelationPath` invocation picks a unique
// leaf alias (`rp_leaf` → `rp_leaf_<N>`) and inner correlation
// references resolve unambiguously against the outer leaf.
//
// `via.kind === "self"` collapses to a no-op: `exists(self,
// where)` → `where`; `exists(self)` → `lit(true)`;
// `missing(self, where)` → `not(where)`; `missing(self)` →
// `lit(false)`. Wrapping self in EXISTS would correlate the
// anchor against itself for a redundant scan.

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
import { RESERVED_SCALAR_COLUMNS } from "./dataTypeTokens";

/** Module-scoped expression builder. Same shape as the sibling compilers. */
const eb = expressionBuilder<Database, keyof Database>();

/**
 * Identical shape to `TermCompileContext` — the predicate compiler
 * threads the same context through every nested compile call. The
 * relational quantifier arm swaps `anchorAlias` to the leaf alias
 * when recursing into an inner `where`.
 */
export type PredicateCompileContext = TermCompileContext;

/**
 * `ComparisonKind` → Postgres operator token. `!=` (not `<>`)
 * matches Postgres's default formatter and the rest of the Nova
 * SQL surface.
 */
const COMPARISON_OPS: Record<ComparisonKind, ComparisonOperator> = {
	eq: "=",
	neq: "!=",
	gt: ">",
	gte: ">=",
	lt: "<",
	lte: "<=",
};

/**
 * `DistanceUnit` → meters. PostGIS's `ST_DWithin` takes meters.
 * `1609.344` is the international mile (NIST handbook 44, the
 * 1959 definition); km → m is unambiguous SI.
 */
const METERS_PER_UNIT: Record<DistanceUnit, number> = {
	miles: 1609.344,
	kilometers: 1000,
};

/** Compile a `Predicate` to a Kysely `Expression<SqlBool>`. */
export function compilePredicate(
	pred: Predicate,
	ctx: PredicateCompileContext,
): Expression<SqlBool> {
	switch (pred.kind) {
		case "match-all":
			// `eb.lit(true)` emits the SQL `true` keyword; binding
			// `true` as a parameter would inflate the parameter list
			// without expressivity gain.
			return eb.lit(true) as Expression<SqlBool>;
		case "match-none":
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

/**
 * Single-source dispatch for every `ValueExpression` operand slot
 * in the Predicate AST. Term-arm → `compileTerm`; non-term arm →
 * `compileExpression` with the thunk-wired callback so the
 * expression compiler's `if.cond` / `count.where` arms recurse
 * back through `compilePredicate`. The runtime callback is the
 * cycle break; neither compiler imports the other through a
 * value-position edge.
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
 * Lift a `PredicateCompileContext` into `ExpressionCompileContext`
 * by attaching the predicate-compiler callback. Named function
 * (not inlined) so the cycle-break wiring is visible at one
 * boundary site. Exported so external compile sites (the case
 * store's sort-expression compile) reuse the same lift.
 */
export function expressionContextFor(
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
 * `(c1) AND (c2) AND ... AND (cN)`. `eb.and([...])` paren-wraps
 * each clause; without wrapping, an unwrapped `or` inside an
 * `and` would silently re-associate (Postgres parses `A OR B AND
 * C` as `A OR (B AND C)` because conjunction binds tighter).
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

/** `(c1) OR (c2) OR ... OR (cN)`. Same paren-wrapping rationale as `compileAnd`. */
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
 * `NOT (clause)`. The builder layer collapses double-negation at
 * construction (`lib/domain/predicate/reduction.ts`), but a
 * directly-constructed nested `not` is still correct — Postgres
 * collapses `NOT (NOT (...))` internally.
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

/** `<left> <op> <right>`. Operator picked from `COMPARISON_OPS`. */
function compileComparison(
	pred: Extract<Predicate, { kind: ComparisonKind }>,
	ctx: PredicateCompileContext,
): Expression<SqlBool> {
	const left = compileValueExprOperand(pred.left, ctx);
	const right = compileValueExprOperand(pred.right, ctx);
	const opToken = COMPARISON_OPS[pred.kind];
	return eb(left, opToken, right);
}

/**
 * `<left> IN (<value>, ...)`. Schema rejects empty value lists at
 * parse time (tuple-with-rest); `.refine` also rejects all-null
 * lists. Mixed null + non-null lists are accepted and compile to
 * `IN (NULL, 'value', ...)` — Postgres's three-valued logic
 * returns `NULL` for `NULL`-left rows, indistinguishable from
 * non-matching in `WHERE` context, so the SQL behaves as authors
 * expect.
 */
function compileIn(
	pred: Extract<Predicate, { kind: "in" }>,
	ctx: PredicateCompileContext,
): Expression<SqlBool> {
	const left = compileValueExprOperand(pred.left, ctx);
	const compiledValues = pred.values.map((v) => compileLiteral(v));
	return eb(left, "in", compiledValues);
}

/**
 * `between` covers three live cases: both bounds, lower-only,
 * upper-only. The schema's `.refine` rejects the both-absent form
 * at parse. Inclusivity flags drive `>=`/`>` and `<=`/`<` via
 * standard interval notation.
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

/**
 * `multi-select-contains` against a JSONB-array property. Operator
 * dispatch per Postgres docs § 9.16.1: `?|` (any-key-exists) for
 * `quantifier: "any"`, `?&` (all-keys-exist) for `quantifier:
 * "all"`. Both take JSONB left and `text[]` right.
 *
 * Non-string tokens (numbers, booleans) reject at the SQL boundary
 * — the JSONB `?|` / `?&` operators match by string equality
 * against array elements, so a non-string token would silently
 * never match. Null literals drop for the same reason (JSONB
 * key-exists has no NULL semantic). The schema's `.refine` rejects
 * all-null lists at parse.
 */
function compileMultiSelectContains(
	pred: Extract<Predicate, { kind: "multi-select-contains" }>,
	ctx: PredicateCompileContext,
): Expression<SqlBool> {
	// `pred.property` carries `kind: "prop"` per `propertyRefSchema`;
	// passing the shape directly avoids TypeScript's spread-overwrite
	// warning. `compileTerm` inherits the JSONB read + `::jsonb` cast
	// for `multi_select` properties.
	const left = compileTerm(pred.property, ctx);

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
	// `eb.val(stringValues)` lets pg's driver apply native
	// array-binding (not a stringified blob).
	return eb(left, operatorToken, eb.val(stringValues));
}

/** `MultiSelectQuantifier` → JSONB containment operator. */
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

/**
 * Per-`MatchMode` dispatch:
 * - `starts-with` → `starts_with(prop::text, value)` (case-sensitive
 *   to match CCHQ's `PROPERTY_VALUE_EXACT` index per
 *   `case_search.py:312-323`).
 * - `fuzzy` → pg_trgm `%` similarity. Threshold is
 *   `pg_trgm.similarity_threshold` (Postgres GUC, default 0.3).
 * - `phonetic` → fuzzystrmatch `dmetaphone` equality. Double
 *   Metaphone is more discriminating than Soundex.
 * - `fuzzy-date` → digit-permutation `IN (...)` matching CCHQ's
 *   `date_permutations` at
 *   `query_functions.py:101-113`.
 */
function compileMatch(
	pred: Extract<Predicate, { kind: "match" }>,
	ctx: PredicateCompileContext,
): Expression<SqlBool> {
	const propRead = compilePropertyAsText(pred.property, ctx);

	// `checkMatch` (the type checker) rejects non-term `value`
	// shapes; this is a type-checker-bypass guard.
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
	// `::text` lifts whatever type the term resolved to into the
	// text domain pg_trgm / fuzzystrmatch / LIKE all expect.
	const valueRead = eb.cast<string>(compileTerm(pred.value.term, ctx), "text");

	switch (pred.mode) {
		case "starts-with":
			// `starts_with(string, prefix)` returns boolean directly
			// without LIKE-meta-character escaping concerns.
			return eb.fn<boolean>("starts_with", [
				propRead,
				valueRead,
			]) as unknown as Expression<SqlBool>;
		case "fuzzy":
			// `%` is in `ARITHMETIC_OPERATORS` (Kysely types these as
			// returning LHS column type); cast at the boundary pins
			// the boolean shape Postgres emits at runtime.
			return eb(propRead, "%", valueRead) as unknown as Expression<SqlBool>;
		case "phonetic":
			return eb(
				eb.fn<string>("dmetaphone", [propRead]),
				"=",
				eb.fn<string>("dmetaphone", [valueRead]),
			);
		case "fuzzy-date":
			// fuzzy-date generates the permutation set at compile
			// time, which requires a literal text value. Dynamic
			// values (search-input / session / property refs) need a
			// Postgres-side permutation function the runtime doesn't
			// yet provide. CSQL and on-device emitters accept dynamic
			// values; only the Postgres path is constrained.
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
 * Read a property as text for `match` mode dispatch. Every match
 * mode reads as text — even for non-text `data_type` ("starts with
 * these characters" is text semantics regardless of the declared
 * type). `compileTerm` handles the JSONB-vs-scalar dispatch and
 * via routing.
 */
function compilePropertyAsText(
	property: PropertyRef,
	ctx: PredicateCompileContext,
): AliasableExpression<string> {
	return eb.cast<string>(compileTerm(property, ctx), "text");
}

/**
 * `fuzzy-date` match — emit `prop IN (perm1, ...)` over the
 * digit-permutation set. Mirrors CCHQ's `date_permutations` at
 * `corehq/apps/case_search/xpath_functions/query_functions.py:116-140`.
 * Throws on inputs that don't parse as `YYYY-MM-DD` so an empty
 * permutation set never produces `<prop> IN ()` (a Postgres syntax
 * error).
 */
function compileFuzzyDate(
	propRead: AliasableExpression<unknown>,
	value: string,
): Expression<SqlBool> {
	const permutations = generateDatePermutations(value);
	if (permutations.length === 0) {
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
	return eb(
		propRead,
		"in",
		permutations.map((p) => eb.val(p)),
	);
}

/**
 * Generate CCHQ's 16 digit-permutation variants from a
 * `YYYY-MM-DD` string (year-decade reversals + month-string
 * reversals + day-string reversals), filtered to structurally
 * valid dates. JS's `Date.parse` is too permissive for parity
 * (accepts `2026-13-01`); the regex + range check matches CCHQ's
 * `datetime.strptime(value, '%Y-%m-%d')` strictness.
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

	// `reverse_decade` swaps the third and fourth year digits
	// (`2026` → `2062`); `reverse_month` / `reverse_day` reverse
	// two-digit strings (`12` → `21`).
	const reverseDecade = `${year[0]}${year[1]}${year[3]}${year[2]}`;
	const reverseMonth = `${month[1]}${month[0]}`;
	const reverseDay = `${day[1]}${day[0]}`;

	// CCHQ's literal 16-variant list. CCHQ's `boost_first=True` is
	// an ES relevance signal; Postgres's `IN` returns a flat
	// boolean, so list order is immaterial to the row set.
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

	// CCHQ filters via `[p for p in permutations if
	// validate_date(p)]`; same filter here. The `Set` deduplicates
	// the variants that collapse to the same string (e.g.
	// `2026-11-11`'s many self-equal swaps).
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
 * Calendar-day validation: month 1-12, day 1-(month length with
 * Gregorian leap-year). Mirrors CCHQ's
 * `datetime.strptime(s, '%Y-%m-%d')` strictness.
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

/**
 * `within-distance` against a geopoint property. The wire form is
 * `"latitude longitude altitude accuracy"` (CCHQ — see
 * `GEOPOINT_PATTERN`); the property reads as text, lat/lon parse
 * via `split_part`, and the predicate builds two `geography`
 * points to feed `ST_DWithin`.
 *
 * `geography` (NOT `geometry`) interprets coordinates as lat/lon
 * on the WGS-84 ellipsoid; `geometry` would treat them as planar
 * units and produce wrong distances at non-equatorial latitudes.
 * `ST_GeogFromText('POINT(<lon> <lat>)')` is the WKT order
 * (opposite of the stored wire shape), so the `split_part` calls
 * below feed `(lon, lat)` to the WKT builder.
 *
 * Distance unit converts to meters at compile time via
 * `METERS_PER_UNIT`; `ST_DWithin` takes meters directly.
 *
 * `pred.center` is a `ValueExpression` — `compileValueExprOperand`
 * dispatches term-arm vs expression-arm so a literal, search-input
 * ref, or computed expression all flow into the same downstream
 * split shape.
 */
function compileWithinDistance(
	pred: Extract<Predicate, { kind: "within-distance" }>,
	ctx: PredicateCompileContext,
): Expression<SqlBool> {
	// `compileTerm` already reads `geopoint` as text per
	// `POSTGRES_CAST_FOR_DATA_TYPE`; the outer `::text` is
	// structurally redundant but documents the type at the split.
	const propText = eb.cast<string>(compileTerm(pred.property, ctx), "text");
	const propLat = splitNumericComponent(propText, 1);
	const propLon = splitNumericComponent(propText, 2);

	const centerText = eb.cast<string>(
		compileValueExprOperand(pred.center, ctx),
		"text",
	);
	const centerLat = splitNumericComponent(centerText, 1);
	const centerLon = splitNumericComponent(centerText, 2);

	const distanceMeters = pred.distance * unitToMeters(pred.unit);

	const propPoint = geographyPoint(propLon, propLat);
	const centerPoint = geographyPoint(centerLon, centerLat);
	return eb.fn<boolean>("st_dwithin", [
		propPoint,
		centerPoint,
		eb.val(distanceMeters),
	]) as unknown as Expression<SqlBool>;
}

/**
 * Build a PostGIS geography point via `ST_GeogFromText('POINT(<lon>
 * <lat>)')`. The function returns geography directly — no separate
 * cast needed, which matters because `geography` isn't in Kysely's
 * `SIMPLE_COLUMN_DATA_TYPES` and the cast-via-named-type path
 * would require raw-SQL emission. SRID 4326 is the documented
 * default per
 * `https://postgis.net/docs/manual-3.6/ST_GeogFromText.html`.
 */
function geographyPoint(
	lon: AliasableExpression<unknown>,
	lat: AliasableExpression<unknown>,
): AliasableExpression<unknown> {
	// Each `eb.val(...)` binds as `unknown` at prepared-statement
	// time; without explicit `text` casts Postgres rejects the
	// `concat(...)` call with "could not determine data type of
	// parameter $N". Casting each fragment to `text` gives
	// `concat(text, text, text, text, text)` — a fully-typed
	// signature Postgres resolves at parse.
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
 * `split_part(<text>, ' ', <pos>)::numeric` for one of the four
 * space-separated components of the geopoint wire form.
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

/** Compile `exists` / `missing`. See file header for strategy + collapse cases. */
function compileExistsOrMissing(
	pred: Extract<Predicate, { kind: "exists" | "missing" }>,
	ctx: PredicateCompileContext,
	mode: "exists" | "missing",
): Expression<SqlBool> {
	if (pred.via.kind === "self") {
		return compileSelfViaQuantifier(pred.where, ctx, mode);
	}

	const compiledPath = compileRelationPath(pred.via, ctx);
	if (compiledPath.kind !== "joined") {
		// `self` branched out above; this throw exists for the
		// narrowing — the runtime branch is dead.
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

	// `anchorAlias` swap routes inner-where self-via reads through
	// the related case row; the depth bump keeps any nested
	// `compileRelationPath` from shadowing this leaf's alias.
	const nextDepth = (ctx.relationPathDepth ?? 0) + 1;
	const innerWhere =
		pred.where !== undefined
			? compilePredicate(pred.where, {
					...ctx,
					anchorAlias: compiledPath.leafAlias,
					relationPathDepth: nextDepth,
				})
			: undefined;

	// `SELECT 1 FROM <leaf> WHERE <leaf>.anchor_case_id =
	// <anchor>.case_id [AND <inner-where>]`. Type-erased via
	// `DynamicExistsQuery` because runtime leaf + anchor aliases
	// can't be enumerated against `Database`'s typed table set.
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

/** AST-level collapse for self-via `exists` / `missing` — no relation-path subquery. */
function compileSelfViaQuantifier(
	where: Predicate | undefined,
	ctx: PredicateCompileContext,
	mode: "exists" | "missing",
): Expression<SqlBool> {
	if (mode === "exists") {
		return where === undefined
			? (eb.lit(true) as Expression<SqlBool>)
			: compilePredicate(where, ctx);
	}
	return where === undefined
		? (eb.lit(false) as Expression<SqlBool>)
		: eb.not(compilePredicate(where, ctx));
}

/**
 * `when-input-present`: compile-time short-circuit. Search-input
 * bindings resolve before compilation, so input-bound → compile
 * `clause`; input-absent → `lit(true)` (the AND-chain identity).
 *
 * "Bound" means `searchInputs.has(name)` regardless of value — an
 * empty-string binding is still bound and the wrapped clause runs.
 * This diverges from CCHQ's wire `count(input)` semantic (which
 * returns 0 for empty strings and skips the clause). Deliberate:
 * Postgres keeps the boundary at "did the request include a value
 * for this input"; "is the value semantically empty" is a clause-
 * specific concern (`is-blank` handles it when authors want).
 * Callers wanting CCHQ-aligned semantics strip blanks before
 * passing bindings.
 */
function compileWhenInputPresent(
	pred: Extract<Predicate, { kind: "when-input-present" }>,
	ctx: PredicateCompileContext,
): Expression<SqlBool> {
	const isBound = ctx.bindings.searchInputs?.has(pred.input.name) ?? false;
	if (isBound) {
		return compilePredicate(pred.clause, ctx);
	}
	return eb.lit(true) as Expression<SqlBool>;
}

/**
 * `is-null` / `is-blank` dispatch — they differ only in the
 * empty-string disjunction. Property-ref left-operands route
 * through `?`-key-existence (Postgres-strict semantics); non-
 * property operands fall back to SQL `IS NULL`.
 */
function compileAbsenceCheck(
	left: ValueExpression,
	ctx: PredicateCompileContext,
	op: "is-null" | "is-blank",
): Expression<SqlBool> {
	if (left.kind === "term" && left.term.kind === "prop") {
		return compilePropertyAbsenceCheck(left.term, ctx, op);
	}

	const operand = compileValueExprOperand(left, ctx);
	if (op === "is-null") {
		return eb(operand, "is", null);
	}
	return eb.or([eb(operand, "is", null), eb(operand, "=", eb.val(""))]);
}

/**
 * Property-ref absence check. Four shapes: self-via reserved
 * scalar (`<col> IS NULL`), self-via JSONB (`?`-existence
 * negation), non-self-via reserved scalar / JSONB (correlated
 * scalar subquery via `compileTerm` then `IS NULL`).
 *
 * Non-self via reads: a no-matching-row case propagates as SQL
 * `NULL` from the scalar subquery, which `IS NULL` reads as
 * absent — "no related case has the property" reads as "the
 * property is null on the related case", matching the term
 * compiler's value-bearing read of the same shape.
 */
function compilePropertyAbsenceCheck(
	property: Extract<Term, { kind: "prop" }>,
	ctx: PredicateCompileContext,
	op: "is-null" | "is-blank",
): Expression<SqlBool> {
	const isSelfVia = property.via === undefined || property.via.kind === "self";
	const propertyName = property.property;

	if (!isSelfVia) {
		const valueRead = compileTerm(property, ctx);
		if (op === "is-null") {
			return eb(valueRead, "is", null);
		}
		return eb.or([eb(valueRead, "is", null), eb(valueRead, "=", eb.val(""))]);
	}

	// Reserved scalars live outside the JSONB document, so `?`
	// doesn't apply — fall back to standard `IS NULL`.
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

	// JSONB-document property: `?` key-existence; `is-blank` adds
	// `properties->>'<key>' = ''` for absent-or-empty.
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

// Type-erased local views — same rationale as
// `compileTerm.ts`'s.

type DynamicExprBuilder = {
	(left: string, op: string, right: unknown): AliasableExpression<unknown>;
	ref: (reference: string) => AliasableExpression<unknown>;
};

/** Builder shape for the EXISTS subquery in `compileExistsOrMissing`. */
interface DynamicExistsQuery {
	whereRef: (left: string, op: string, right: string) => DynamicExistsQuery;
	where: (predicate: Expression<unknown>) => DynamicExistsQuery;
	select: (selection: AliasedExpression<unknown, string>) => DynamicExistsQuery;
}
