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
import { expressionBuilder, sql } from "kysely";
import { distanceToMeters } from "@/lib/domain/predicate/distance";
import {
	compilerBugMessage,
	typeCheckerBypassMessage,
	unhandledKindMessage,
} from "@/lib/domain/predicate/errors";
import {
	canonicalizeRelationPath,
	normalizeRelationEvaluationScopes,
} from "@/lib/domain/predicate/normalizeRelationEvaluationScopes";
import type {
	ComparisonKind,
	MultiSelectQuantifier,
	Predicate,
	PropertyRef,
	Term,
	ValueExpression,
} from "@/lib/domain/predicate/types";
import { walkPropertyRefs } from "@/lib/domain/predicate/walk";
import {
	type CompilePredicateThunk,
	compileExpression,
	type ExpressionCompileContext,
} from "./compileExpression";
import { compileRelationPath } from "./compileRelationPath";
import { compileTerm, type TermCompileContext } from "./compileTerm";
import type { Database } from "./database";
import { RESERVED_SCALAR_COLUMN_BY_PROPERTY } from "./dataTypeTokens";

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

const GEOPOINT_NUMBER_PATTERN = String.raw`-?(?:[0-9]{1,32}(?:\.[0-9]{0,32})?|\.[0-9]{1,32})`;
const GEOPOINT_METADATA_NUMBER_PATTERN = String.raw`[+-]?(?:[0-9]{1,32}(?:\.[0-9]{0,32})?|\.[0-9]{1,32})(?:[eE][+-]?[0-9]{1,3})?`;
const GEOPOINT_METADATA_PATTERN = `(?:${GEOPOINT_METADATA_NUMBER_PATTERN}|NaN)`;
const GEOPOINT_PROPERTY_PATTERN = `^${GEOPOINT_NUMBER_PATTERN} ${GEOPOINT_NUMBER_PATTERN}(?: ${GEOPOINT_METADATA_PATTERN} ${GEOPOINT_METADATA_PATTERN})?$`;
const GEOPOINT_CENTER_PATTERN = `^${GEOPOINT_NUMBER_PATTERN} ${GEOPOINT_NUMBER_PATTERN}(?: ${GEOPOINT_METADATA_PATTERN} ${GEOPOINT_METADATA_PATTERN})?$`;
const SQL_ASCII_WHITESPACE = "[ \t\n\u000b\f\r]";
const GEOPOINT_RAW_CENTER_PATTERN = `^(?:${SQL_ASCII_WHITESPACE}*${GEOPOINT_NUMBER_PATTERN}${SQL_ASCII_WHITESPACE}+${GEOPOINT_NUMBER_PATTERN}(?:${SQL_ASCII_WHITESPACE}+${GEOPOINT_METADATA_PATTERN}${SQL_ASCII_WHITESPACE}+${GEOPOINT_METADATA_PATTERN})?${SQL_ASCII_WHITESPACE}*|${SQL_ASCII_WHITESPACE}*${GEOPOINT_NUMBER_PATTERN}${SQL_ASCII_WHITESPACE}*,${SQL_ASCII_WHITESPACE}*${GEOPOINT_NUMBER_PATTERN}${SQL_ASCII_WHITESPACE}*)$`;

/** Compile a `Predicate` to a Kysely `Expression<SqlBool>`. */
export function compilePredicate(
	pred: Predicate,
	ctx: PredicateCompileContext,
): Expression<SqlBool> {
	const normalizedSubject = normalizeRelationEvaluationScopes(pred, {
		caseTypes: [...ctx.caseTypeSchemas.values()],
		...(ctx.currentCaseType === undefined
			? {}
			: { currentCaseType: ctx.currentCaseType }),
	});
	if (normalizedSubject !== pred) {
		return compilePredicate(normalizedSubject, ctx);
	}
	assertNoUnnormalizedRelationPropertyRefs(pred);
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
 * Relation-valued property reads must have been converted to an explicit
 * one-row `exists(via, where: ...)` scope before SQL emission. Keeping this
 * defense at the compiler boundary prevents a future normalizer regression
 * from falling back to an arbitrary scalar subquery row or inventing
 * cross-product semantics that CommCare Core does not implement.
 */
function assertNoUnnormalizedRelationPropertyRefs(pred: Predicate): void {
	let survivingProperty: PropertyRef | undefined;
	walkPropertyRefs(pred, (property) => {
		if (
			survivingProperty === undefined &&
			property.via !== undefined &&
			property.via.kind !== "self"
		) {
			survivingProperty = property;
		}
	});
	if (survivingProperty === undefined) return;

	throw new Error(
		compilerBugMessage({
			where: "compilePredicate",
			invariant:
				"relation-valued PropertyRefs are normalized into explicit exists scopes before SQL emission",
			detail: `Property '${survivingProperty.property}' retained a '${survivingProperty.via?.kind}' relation path after normalizeRelationEvaluationScopes. Extend that pass instead of compiling the read as a scalar or cross-product.`,
		}),
	);
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
	return eb(
		compileValueExprOperand(pred.left, ctx),
		COMPARISON_OPS[pred.kind],
		compileValueExprOperand(pred.right, ctx),
	);
}

/**
 * `in` compiles as an OR of scalar equalities. A relation-valued left side has
 * already become `exists(via, where: in(prop(self), ...))`, so every equality
 * here evaluates against one related row at a time.
 */
function compileIn(
	pred: Extract<Predicate, { kind: "in" }>,
	ctx: PredicateCompileContext,
): Expression<SqlBool> {
	return eb.or(
		pred.values.map((value) =>
			eb(compileValueExprOperand(pred.left, ctx), "=", compileTerm(value, ctx)),
		),
	);
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
	const lowerOp: ComparisonOperator = pred.lowerInclusive ? ">=" : ">";
	const upperOp: ComparisonOperator = pred.upperInclusive ? "<=" : "<";

	if (pred.lower !== undefined && pred.upper !== undefined) {
		// Relation normalization deliberately splits related two-bound ranges into
		// two independently quantified comparisons before this scalar helper runs.
		return eb.and([
			eb(
				compileValueExprOperand(pred.left, ctx),
				lowerOp,
				compileValueExprOperand(pred.lower, ctx),
			),
			eb(
				compileValueExprOperand(pred.left, ctx),
				upperOp,
				compileValueExprOperand(pred.upper, ctx),
			),
		]);
	}
	if (pred.lower !== undefined) {
		return eb(
			compileValueExprOperand(pred.left, ctx),
			lowerOp,
			compileValueExprOperand(pred.lower, ctx),
		);
	}
	if (pred.upper !== undefined) {
		return eb(
			compileValueExprOperand(pred.left, ctx),
			upperOp,
			compileValueExprOperand(pred.upper, ctx),
		);
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
 * Per-`MatchMode` dispatch. `fuzzy` and `phonetic` mirror what
 * CommCare HQ's Elasticsearch case-search does so preview search
 * behaves the same as the exported app. Both work on TOKENS, where
 * a token list = the text lowercased and split on runs of non-
 * alphanumeric characters (an approximation of ES's standard
 * analyzer — close enough for Latin-script names and the property
 * values preview deals with).
 *
 * - `starts-with` → `starts_with(prop::text, value)` (case-sensitive
 *   to match CCHQ's `case_property_starts_with` index path).
 * - `fuzzy` → a row matches when EITHER: (a) some property token is
 *   within ES "AUTO" edit distance of the whole lowercased query
 *   string and shares its first two characters (the term-level
 *   fuzzy query, prefix_length=2), OR (b) some query token exactly
 *   equals some property token (the non-fuzzy analyzed match ORed
 *   in to boost exact hits). Example: "smith" matches "Smyth"
 *   (one edit, shared "sm" prefix) via (a); "felipe kan" matches
 *   "Felipe Khan" via (b)'s shared exact "felipe" token, while
 *   "kan" alone matches neither (no shared exact token, and its
 *   "ka" prefix differs from "khan"'s "kh").
 * - `phonetic` → a row matches when some query token and some
 *   property token share a Soundex code. Per-token (not whole-
 *   string) so "bob" matches "bob smith". Example: "smith" matches
 *   "Smyth" (both Soundex S530).
 * - `fuzzy-date` → digit-permutation `IN (...)` matching CCHQ's
 *   `query_functions.py::date_permutations`.
 */
function compileMatch(
	pred: Extract<Predicate, { kind: "match" }>,
	ctx: PredicateCompileContext,
): Expression<SqlBool> {
	const propRead = compilePropertyAsText(pred.property, ctx);

	// `checkMatch` admits the full ValueExpression family: authored search can
	// normalize a prefix with `concat`, choose one with `if`, or read the
	// authenticated session. Route the whole value through the shared operand
	// dispatcher so SQL has the same admission surface as the domain and wire
	// compilers. `::text` then lifts whatever type the expression resolved to into the
	// text domain `starts_with`, the tokenizer (`lower` /
	// `regexp_split_to_array`), and fuzzystrmatch all expect.
	const valueRead = eb.cast<string>(
		compileValueExprOperand(pred.value, ctx),
		"text",
	);

	switch (pred.mode) {
		case "starts-with":
			// `starts_with(string, prefix)` returns boolean directly
			// without LIKE-meta-character escaping concerns.
			return eb.fn<boolean>("starts_with", [
				propRead,
				valueRead,
			]) as unknown as Expression<SqlBool>;
		case "fuzzy":
			return compileFuzzyMatch(propRead, valueRead, ctx);
		case "phonetic":
			return compilePhoneticMatch(propRead, valueRead, ctx);
		case "fuzzy-date":
			// Keep the literal fast path: it validates the authoring-time value and
			// binds only the surviving permutations. Dynamic expressions use the
			// SQL lowering below, where the same 16 candidates are constructed and
			// calendar-validated per request.
			if (
				pred.value.kind === "term" &&
				pred.value.term.kind === "literal" &&
				typeof pred.value.term.value === "string"
			) {
				return compileLiteralFuzzyDate(propRead, pred.value.term.value);
			}
			return compileDynamicFuzzyDate(propRead, valueRead);
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
 * Tokenize a text expression the way the `fuzzy` / `phonetic` match
 * modes need: lowercase, split on runs of non-alphanumeric
 * characters, and drop the empty fragments a leading/trailing
 * delimiter leaves behind. The result is a `text[]` of tokens.
 *
 * This approximates Elasticsearch's standard analyzer (which both
 * match modes run over `case_properties.value`). It splits on
 * punctuation and whitespace and lowercases, which is faithful for
 * the Latin-script property values preview search handles; it does
 * not reproduce ES's Unicode word-boundary rules for scripts
 * without spaces. `array_remove(..., '')` mirrors the analyzer
 * never emitting an empty token, so a query that is all punctuation
 * (e.g. "—") tokenizes to an empty array and matches nothing
 * instead of spuriously matching on a shared empty string.
 */
function tokenize(
	textExpr: AliasableExpression<unknown>,
): AliasableExpression<string[]> {
	const lowered = eb.fn<string>("lower", [textExpr]);
	const split = eb.fn<string[]>("regexp_split_to_array", [
		lowered,
		eb.cast<string>(eb.val("[^a-z0-9]+"), "text"),
	]);
	return eb.fn<string[]>("array_remove", [
		split,
		eb.cast<string>(eb.val(""), "text"),
	]);
}

/**
 * `fuzzy` match — the OR of CommCare HQ's two case-search clauses:
 *
 *   (a) Term-level fuzzy. HQ sends the whole lowercased query
 *       string as ONE fuzzy term (term-level = not tokenized) with
 *       `fuzziness=AUTO` and `prefix_length=2`. Here: EXISTS a
 *       property token whose first two characters equal the query
 *       string's first two (the fixed prefix ES never edits) and
 *       whose Levenshtein distance to the whole lowercased query
 *       string is within the AUTO budget — 0 edits for length ≤ 2,
 *       1 for 3–5, 2 for ≥ 6, computed from the query length in SQL
 *       so dynamic (search-input) values get the same rule as
 *       literals. `levenshtein` is fuzzystrmatch.
 *
 *   (b) Non-fuzzy analyzed match, operator OR, fuzziness 0. HQ ORs
 *       this in to boost exact hits. Here: the property and query
 *       token arrays overlap (`&&`) — i.e. some query token exactly
 *       equals some property token.
 */
function compileFuzzyMatch(
	propRead: AliasableExpression<string>,
	valueRead: AliasableExpression<string>,
	ctx: PredicateCompileContext,
): Expression<SqlBool> {
	const propTokens = tokenize(propRead);
	const queryTokens = tokenize(valueRead);
	// The whole query string, lowercased and NOT tokenized — the
	// term-level fuzzy query's single comparand.
	const queryString = eb.fn<string>("lower", [valueRead]);

	// `pt` is the per-row token the `unnest(...) AS pt` table-function
	// source below exposes; the single output column takes the table
	// alias name.
	const tokenRef = (eb as DynamicExprBuilder).ref("pt");
	const sharesPrefix = eb(
		eb.fn<string>("left", [tokenRef, eb.lit(2)]),
		"=",
		eb.fn<string>("left", [queryString, eb.lit(2)]),
	);
	const queryLength = eb.fn<number>("length", [queryString]);
	const autoFuzziness = eb
		.case()
		.when(eb(queryLength, "<=", eb.lit(2)))
		.then(eb.lit(0))
		.when(eb(queryLength, "<=", eb.lit(5)))
		.then(eb.lit(1))
		.else(eb.lit(2))
		.end();
	const withinEditDistance = eb(
		eb.fn<number>("levenshtein", [tokenRef, queryString]),
		"<=",
		autoFuzziness,
	);

	const termFuzzySubquery = (
		ctx.db.selectFrom(
			eb.fn<string>("unnest", [propTokens]).as("pt") as unknown as never,
		) as unknown as DynamicFromFunctionQuery
	)
		.where(eb.and([sharesPrefix, withinEditDistance]))
		.select(eb.lit(1).as("one"));
	const termFuzzyMatch = eb.exists(
		termFuzzySubquery as unknown as Expression<unknown>,
	);

	const exactTokenOverlap = eb(
		propTokens,
		"&&",
		queryTokens,
	) as unknown as Expression<SqlBool>;

	return eb.or([termFuzzyMatch, exactTokenOverlap]);
}

/**
 * `phonetic` match — CommCare HQ runs a match query over the
 * `.phonetic` subfield, which tokenizes (standard analyzer),
 * lowercases, and Soundex-encodes each token, then matches with the
 * default OR operator. Here: EXISTS a query token and a property
 * token that share a Soundex code. Per-token (not whole-string) so
 * "bob" matches "bob smith". `soundex` is fuzzystrmatch.
 *
 * HQ uses Soundex specifically (its phonetic analyzer's `encoder`),
 * not Double Metaphone.
 */
function compilePhoneticMatch(
	propRead: AliasableExpression<string>,
	valueRead: AliasableExpression<string>,
	ctx: PredicateCompileContext,
): Expression<SqlBool> {
	const propTokens = tokenize(propRead);
	const queryTokens = tokenize(valueRead);
	// `pt` / `qt` are the per-row tokens the two `unnest(...)` sources
	// expose; the single output column takes the table alias name.
	const propTokenRef = (eb as DynamicExprBuilder).ref("pt");
	const queryTokenRef = (eb as DynamicExprBuilder).ref("qt");
	const soundexEqual = eb(
		eb.fn<string>("soundex", [propTokenRef]),
		"=",
		eb.fn<string>("soundex", [queryTokenRef]),
	);

	const subquery = (
		ctx.db.selectFrom([
			eb.fn<string>("unnest", [propTokens]).as("pt"),
			eb.fn<string>("unnest", [queryTokens]).as("qt"),
		] as unknown as never) as unknown as DynamicFromFunctionQuery
	)
		.where(soundexEqual)
		.select(eb.lit(1).as("one"));
	return eb.exists(subquery as unknown as Expression<unknown>);
}

/**
 * `fuzzy-date` match — emit `prop IN (perm1, ...)` over the
 * digit-permutation set. Mirrors CCHQ's
 * `corehq/apps/case_search/xpath_functions/query_functions.py::date_permutations`.
 * Throws on inputs that don't parse as `YYYY-MM-DD` so an empty
 * permutation set never produces `<prop> IN ()` (a Postgres syntax
 * error).
 */
function compileLiteralFuzzyDate(
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
 * Runtime `fuzzy-date` lowering for computed/input/session values. CCHQ's
 * `date_permutations` builds sixteen strings by swapping month/day digits and
 * the last two year digits, then drops candidates that do not parse as a
 * strict `%Y-%m-%d` calendar date. This is that same algorithm expressed as
 * SQL, so a valid non-literal ValueExpression never reaches a compiler-only
 * literal guard.
 *
 * The outer source value and every generated candidate are calendar-gated.
 * That matters for candidates such as `2024-31-01`: including the raw string
 * in the OR would let malformed stored text match even though HQ filters it
 * out. `isValidDynamicIsoDate` uses nested CASE arms before integer casts, so
 * an arbitrary computed string resolves to false rather than a Postgres cast
 * error.
 */
function compileDynamicFuzzyDate(
	propRead: AliasableExpression<unknown>,
	valueRead: AliasableExpression<string>,
): Expression<SqlBool> {
	const year = sqlSubstring(valueRead, 1, 4);
	const month = sqlSubstring(valueRead, 6, 2);
	const day = sqlSubstring(valueRead, 9, 2);
	const reverseDecade = sql<string>`${sqlSubstring(year, 1, 2)} || ${sqlSubstring(year, 4, 1)} || ${sqlSubstring(year, 3, 1)}`;
	const reverseMonth = reverseTwoDigits(month);
	const reverseDay = reverseTwoDigits(day);
	const date = (
		yearPart: AliasableExpression<string>,
		monthPart: AliasableExpression<string>,
		dayPart: AliasableExpression<string>,
	) => sql<string>`${yearPart} || '-' || ${monthPart} || '-' || ${dayPart}`;

	const candidates = [
		valueRead,
		date(year, day, month),
		date(year, reverseMonth, day),
		date(year, day, reverseMonth),
		date(year, month, reverseDay),
		date(year, reverseDay, month),
		date(year, reverseMonth, reverseDay),
		date(year, reverseDay, reverseMonth),
		date(reverseDecade, month, day),
		date(reverseDecade, day, month),
		date(reverseDecade, reverseMonth, day),
		date(reverseDecade, day, reverseMonth),
		date(reverseDecade, month, reverseDay),
		date(reverseDecade, reverseDay, month),
		date(reverseDecade, reverseMonth, reverseDay),
		date(reverseDecade, reverseDay, reverseMonth),
	];

	return eb.and([
		isValidDynamicIsoDate(valueRead),
		eb.or(
			candidates.map((candidate) =>
				eb.and([
					isValidDynamicIsoDate(candidate),
					eb(propRead, "=", candidate),
				]),
			),
		),
	]);
}

function sqlSubstring(
	value: AliasableExpression<string>,
	start: number,
	length: number,
): AliasableExpression<string> {
	return eb.fn<string>("substr", [value, eb.lit(start), eb.lit(length)]);
}

function reverseTwoDigits(
	value: AliasableExpression<string>,
): AliasableExpression<string> {
	return sql<string>`${sqlSubstring(value, 2, 1)} || ${sqlSubstring(value, 1, 1)}`;
}

const ISO_DATE_TEXT_PATTERN = "^[0-9]{4}-[0-9]{2}-[0-9]{2}$";

/** Strict Gregorian `%Y-%m-%d` check without a throwing `to_date` cast. */
function isValidDynamicIsoDate(
	value: AliasableExpression<string>,
): Expression<SqlBool> {
	const year = sql<number>`(${sqlSubstring(value, 1, 4)})::integer`;
	const month = sql<number>`(${sqlSubstring(value, 6, 2)})::integer`;
	const day = sql<number>`(${sqlSubstring(value, 9, 2)})::integer`;
	const daysInMonth = sql<number>`case
		when ${month} in (1, 3, 5, 7, 8, 10, 12) then 31
		when ${month} in (4, 6, 9, 11) then 30
		when ${month} = 2 then case
			when (${year} % 400 = 0 or (${year} % 4 = 0 and ${year} % 100 != 0)) then 29
			else 28
		end
		else 0
	end`;

	return sql<SqlBool>`case
		when ${value} ~ ${ISO_DATE_TEXT_PATTERN} then
			case
				when ${year} between 1 and 9999 and ${month} between 1 and 12 and ${day} >= 1
					then ${day} <= ${daysInMonth}
				else false
			end
		else false
	end`;
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
	// Python's `datetime.strptime(..., "%Y-%m-%d")` admits years 1–9999.
	// The four-digit regex alone would otherwise let year 0000 diverge from
	// both HQ and the dynamic SQL guard above.
	if (y < 1 || y > 9999 || m < 1 || m > 12 || d < 1) return false;
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
 * the domain's shared conversion; `ST_DWithin` takes meters directly.
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

	const rawCenterText = eb.cast<string>(
		compileValueExprOperand(pred.center, ctx),
		"text",
	);
	const centerText = normalizeGeopointText(rawCenterText);
	const centerLat = splitNumericComponent(centerText, 1);
	const centerLon = splitNumericComponent(centerText, 2);

	const distanceMeters = distanceToMeters(pred.distance, pred.unit);
	const validShapes = eb.and([
		eb(propText, "~", eb.val(GEOPOINT_PROPERTY_PATTERN)),
		eb(rawCenterText, "~", eb.val(GEOPOINT_RAW_CENTER_PATTERN)),
		eb(centerText, "~", eb.val(GEOPOINT_CENTER_PATTERN)),
	]);
	const validRanges = eb.and([
		eb(propLat, ">=", eb.lit(-90)),
		eb(propLat, "<=", eb.lit(90)),
		eb(propLon, ">=", eb.lit(-180)),
		eb(propLon, "<=", eb.lit(180)),
		eb(centerLat, ">=", eb.lit(-90)),
		eb(centerLat, "<=", eb.lit(90)),
		eb(centerLon, ">=", eb.lit(-180)),
		eb(centerLon, "<=", eb.lit(180)),
	]);
	const distanceMatches = eb.fn<boolean>("st_dwithin", [
		geographyPoint(propLon, propLat),
		geographyPoint(centerLon, centerLat),
		eb.val(distanceMeters),
		// Core and Elasticsearch use a spherical distance model. PostGIS
		// geography defaults to the WGS-84 spheroid, so pass `false` explicitly
		// for cross-target threshold parity.
		eb.lit(false),
	]);

	// Keep casts and PostGIS parsing behind nested CASE arms. PostgreSQL may
	// reorder boolean AND terms, so one flat `shape AND range AND distance`
	// expression would still be allowed to evaluate `::numeric` on malformed
	// text. CASE evaluates only the selected result arm.
	const rangeGuarded = eb
		.case()
		.when(validRanges)
		.then(distanceMatches)
		.else(false)
		.end();
	return eb
		.case()
		.when(validShapes)
		.then(rangeGuarded)
		.else(false)
		.end() as Expression<SqlBool>;
}

/** Canonical CCHQ geopoint text: commas to spaces, whitespace collapsed. */
function normalizeGeopointText(
	text: AliasableExpression<string>,
): AliasableExpression<string> {
	const commaNormalized = eb.fn<string>("replace", [
		text,
		textConstant(","),
		textConstant(" "),
	]);
	const whitespaceNormalized = eb.fn<string>("regexp_replace", [
		commaNormalized,
		textConstant("[[:space:]]+"),
		textConstant(" "),
		textConstant("g"),
	]);
	return eb.fn<string>("btrim", [whitespaceNormalized]);
}

function textConstant(value: string): AliasableExpression<string> {
	return eb.cast<string>(eb.val(value), "text");
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

/** Compile `exists` / `missing`. See file header for strategy + collapse cases. */
function compileExistsOrMissing(
	pred: Extract<Predicate, { kind: "exists" | "missing" }>,
	ctx: PredicateCompileContext,
	mode: "exists" | "missing",
): Expression<SqlBool> {
	const relation = canonicalizeRelationPath(pred.via, {
		caseTypes: [...ctx.caseTypeSchemas.values()],
		...(ctx.currentCaseType === undefined
			? {}
			: { currentCaseType: ctx.currentCaseType }),
	});
	if (relation.via.kind === "self") {
		return compileSelfViaQuantifier(pred.where, ctx, mode);
	}

	const compiledPath = compileRelationPath(relation.via, ctx);
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
					...(relation.destinationCaseType === undefined
						? {}
						: { currentCaseType: relation.destinationCaseType }),
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
 * Property-ref absence check for the current row. Relation-valued absence
 * checks are normalized to an explicit exists scope before reaching here.
 */
function compilePropertyAbsenceCheck(
	property: Extract<Term, { kind: "prop" }>,
	ctx: PredicateCompileContext,
	op: "is-null" | "is-blank",
): Expression<SqlBool> {
	const isSelfVia = property.via === undefined || property.via.kind === "self";
	const propertyName = property.property;
	const reserved = RESERVED_SCALAR_COLUMN_BY_PROPERTY.get(propertyName);
	// A non-blankable reserved scalar (a timestamp column) collapses
	// `is-blank` to plain `IS NULL` — `''` isn't a value the column
	// can hold, and comparing a timestamp to `''` is a Postgres type
	// error, not `false`.
	if (!isSelfVia) {
		throw new Error(
			compilerBugMessage({
				where: "compilePredicate.compilePropertyAbsenceCheck",
				invariant:
					"relation-valued absence checks are normalized into explicit exists scopes",
				detail: `Property '${property.property}' retained a '${property.via?.kind}' relation path.`,
			}),
		);
	}

	// Reserved scalars live outside the JSONB document, so `?`
	// doesn't apply — fall back to standard `IS NULL`.
	const sourceAlias = ctx.anchorAlias;
	if (reserved !== undefined) {
		const columnRef = (eb as DynamicExprBuilder).ref(
			`${sourceAlias}.${reserved.column}`,
		);
		if (op === "is-null" || !reserved.blankable) {
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
	const textRead = (eb as DynamicExprBuilder)
		.ref(propertiesRef, "->>")
		.key(propertyName);
	return eb.or([eb.not(keyExists), eb(textRead, "=", eb.val(""))]);
}

// Type-erased local views — same rationale as
// `compileTerm.ts`'s.

type DynamicExprBuilder = {
	(left: string, op: string, right: unknown): AliasableExpression<unknown>;
	ref: {
		(reference: string): AliasableExpression<unknown>;
		(
			reference: string,
			op: "->" | "->>",
		): { key: (key: string) => AliasableExpression<unknown> };
	};
};

/** Builder shape for the EXISTS subquery in `compileExistsOrMissing`. */
interface DynamicExistsQuery {
	whereRef: (left: string, op: string, right: string) => DynamicExistsQuery;
	where: (predicate: Expression<unknown>) => DynamicExistsQuery;
	select: (selection: AliasedExpression<unknown, string>) => DynamicExistsQuery;
}

/**
 * Builder shape for the `unnest(...)`-token EXISTS subqueries in
 * `compileFuzzyMatch` / `compilePhoneticMatch`. The FROM source is a
 * set-returning function (or a comma-pair of them) whose runtime
 * alias + column can't be enumerated against `Database`'s typed
 * table set, so the chain runs type-erased.
 */
interface DynamicFromFunctionQuery {
	where: (predicate: Expression<unknown>) => DynamicFromFunctionQuery;
	select: (
		selection: AliasedExpression<unknown, string>,
	) => DynamicFromFunctionQuery;
}
