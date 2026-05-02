// lib/case-store/sql/compilePredicate.ts
//
// Compile a `Predicate` AST node to a Kysely boolean expression.
// The case-list query layer feeds the result into a `where(...)`
// clause; the predicate compiler returns a `RawBuilder<SqlBool>`
// satisfying the `Expression<SqlBool>` interface Kysely's `where`
// accepts.
//
// ## What this module owns
//
// Per-arm dispatch for every kind in the `Predicate` discriminated
// union — sentinels, logical, comparison, membership, range,
// multi-select containment, text match (four modes), geo,
// relational, conditional, and the null / blank operators. Term
// emission delegates to `./compileTerm`; relation-path subqueries
// delegate to `./compileRelationPath`. The compiler accepts only
// the `term` arm of `ValueExpression` at every operand slot —
// `comparison.left` / `.right`, `in.left`, `between.left` /
// `.lower` / `.upper`, `is-null.left`, `is-blank.left`, and
// `within-distance.center` — and rejects every other arm with a
// clear error at the call site. The non-`term` arms of
// `ValueExpression` (`arith`, `if`, `count`, etc.) belong to a
// sibling expression-compiler module; calling code that needs
// expression-shaped operands routes them through that module
// before passing them to the predicate compiler.
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

import type { RawBuilder, SqlBool } from "kysely";
import { sql } from "kysely";
import type {
	ComparisonKind,
	DistanceUnit,
	Literal,
	MultiSelectQuantifier,
	Predicate,
	PropertyRef,
	Term,
	ValueExpression,
} from "@/lib/domain/predicate/types";
import { compileRelationPath } from "./compileRelationPath";
import {
	compileTerm,
	POSTGRES_CAST_FOR_DATA_TYPE,
	type TermCompileContext,
} from "./compileTerm";

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
const COMPARISON_OPS: Record<ComparisonKind, string> = {
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
 * The return type is `RawBuilder<SqlBool>`. Kysely's `where(...)`
 * accepts any `Expression<SqlBool>`; the raw-builder shape
 * satisfies that interface and exposes `.toOperationNode()` for
 * the test suite to inspect the emitted SQL via `.compile()`.
 */
export function compilePredicate(
	pred: Predicate,
	ctx: PredicateCompileContext,
): RawBuilder<SqlBool> {
	switch (pred.kind) {
		case "match-all":
			// Boolean-algebra identity element. `true` is a Postgres
			// keyword (not a value), so the SQL keyword form is the
			// canonical shape — binding `true` as a parameter would
			// inflate the parameter list without any expressivity
			// gain.
			return sql<SqlBool>`true`;
		case "match-none":
			// Boolean-algebra absorbing element. Mirrors the
			// `match-all` rationale.
			return sql<SqlBool>`false`;
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
				`compilePredicate: unhandled Predicate kind ${String(_exhaustive)}`,
			);
		}
	}
}

// ---------------------------------------------------------------
// ValueExpression operand bridge — term-arm-only
// ---------------------------------------------------------------

/**
 * Compile a `ValueExpression` operand to a Kysely expression by
 * routing the `term` arm through `compileTerm`. The predicate
 * compiler accepts only the `term` arm of `ValueExpression` at
 * every operand slot; every other arm (`arith`, `if`, `switch`,
 * `count`, etc.) belongs to the sibling expression-compiler module
 * and is rejected here with a clear error.
 *
 * Centralizing the dispatch in one helper means the throw-site is
 * one place. Every predicate operator that accepts
 * `ValueExpression` operands routes through this helper, so a
 * regression that surfaces a non-term operand from a fresh AST
 * shape lands at one error message rather than five.
 *
 * The Predicate AST keeps `ValueExpression` operands in seven slots:
 * `comparison.left` / `.right`, `in.left`, `between.left` /
 * `.lower` / `.upper`, `is-null.left`, `is-blank.left`, and
 * `within-distance.center`. Each call site below routes through
 * this helper. Calling code that needs expression-shaped operands
 * compiles them through the expression compiler before reaching
 * the predicate compiler.
 */
function compileValueExprAsTerm(
	expr: ValueExpression,
	ctx: PredicateCompileContext,
): RawBuilder<unknown> {
	if (expr.kind === "term") {
		return compileTerm(expr.term, ctx);
	}
	throw new Error(
		`compilePredicate accepts only term-arm ValueExpression operands; received kind '${expr.kind}'. Compile non-term ValueExpression operands through the sibling expression compiler before passing them to compilePredicate.`,
	);
}

// ---------------------------------------------------------------
// Logical operators — `and` / `or` / `not`
// ---------------------------------------------------------------

/**
 * Conjunction: `(c1) AND (c2) AND ... AND (cN)`. Each clause's
 * compiled SQL is paren-wrapped so a clause containing an `or` (or
 * any operator binding looser than `and`) keeps its grouping when
 * spliced into the conjunction. Postgres parses `A OR B AND C` as
 * `A OR (B AND C)` — the conjunction binds tighter — so an
 * unwrapped `or`-clause inside an `and` would silently re-associate.
 *
 * `clauses` is non-empty by construction (the schema's tuple-with-
 * rest shape rejects empty `and` lists), so the `sql.join(...)`
 * call always produces at least one fragment.
 */
function compileAnd(
	pred: Extract<Predicate, { kind: "and" }>,
	ctx: PredicateCompileContext,
): RawBuilder<SqlBool> {
	const compiled = pred.clauses.map(
		// Each clause is paren-wrapped to defend against precedence
		// re-association inside the parent conjunction.
		(c) => sql`(${compilePredicate(c, ctx)})`,
	);
	return sql<SqlBool>`${sql.join(compiled, sql` and `)}`;
}

/**
 * Disjunction: `(c1) OR (c2) OR ... OR (cN)`. Same paren-wrapping
 * rationale as `compileAnd` — each clause defends its own grouping
 * inside the outer disjunction. Symmetric structure.
 */
function compileOr(
	pred: Extract<Predicate, { kind: "or" }>,
	ctx: PredicateCompileContext,
): RawBuilder<SqlBool> {
	const compiled = pred.clauses.map((c) => sql`(${compilePredicate(c, ctx)})`);
	return sql<SqlBool>`${sql.join(compiled, sql` or `)}`;
}

/**
 * Negation: `NOT (clause)`. The paren-wrap keeps the inner clause's
 * grouping intact under the outer `NOT` — `NOT A AND B` parses as
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
): RawBuilder<SqlBool> {
	return sql<SqlBool>`not (${compilePredicate(pred.clause, ctx)})`;
}

// ---------------------------------------------------------------
// Comparison — six operators
// ---------------------------------------------------------------

/**
 * Compile a comparison: `<left> <op> <right>`. Both operands are
 * `ValueExpression`; `compileValueExprAsTerm` routes the `term`
 * arm through `compileTerm` and throws on every other arm (the
 * non-term arms are an expression-compiler integration concern).
 *
 * The SQL operator is picked from `COMPARISON_OPS`, the closed
 * `Record<ComparisonKind, string>` declared at the top of the
 * file. `sql.raw(opToken)` is safe because the source value comes
 * from a closed-enum lookup — there's no path for an attacker-
 * controlled string to reach the operator slot.
 */
function compileComparison(
	pred: Extract<Predicate, { kind: ComparisonKind }>,
	ctx: PredicateCompileContext,
): RawBuilder<SqlBool> {
	const left = compileValueExprAsTerm(pred.left, ctx);
	const right = compileValueExprAsTerm(pred.right, ctx);
	const opToken = COMPARISON_OPS[pred.kind];
	return sql<SqlBool>`${left} ${sql.raw(opToken)} ${right}`;
}

// ---------------------------------------------------------------
// `in` — value-equality set membership
// ---------------------------------------------------------------

/**
 * Compile an `in` predicate: `<left> IN (<value>, <value>, ...)`. Each
 * literal value flows through `compileLiteralValue` for parameter
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
): RawBuilder<SqlBool> {
	const left = compileValueExprAsTerm(pred.left, ctx);
	const compiledValues = pred.values.map((v) => compileLiteralValue(v));
	return sql<SqlBool>`${left} in (${sql.join(compiledValues)})`;
}

/**
 * Compile a literal value to a Kysely expression for use in
 * `in.values`. Each literal binds as a parameter (or emits as the
 * SQL `NULL` keyword for null literals); typed-data literals
 * (`dateLiteral` / `datetimeLiteral` / `timeLiteral`) emit with
 * the corresponding cast token so equality dispatch against a
 * typed property read stays well-typed.
 *
 * The cast-token lookup reads `POSTGRES_CAST_FOR_DATA_TYPE` (the
 * `data_type` → Postgres type mapping exported from compileTerm)
 * directly rather than threading the literal back through
 * compileTerm with a synthesized context. Reading the table
 * directly keeps the cast logic single-source — extending the
 * blueprint's `data_type` enum forces a `Record<...>` exhaustivity
 * check in the one shared table — without coupling literal-emission
 * here to compileTerm's internal context surface.
 */
function compileLiteralValue(lit: Literal): RawBuilder<unknown> {
	if (lit.value === null) {
		return sql`null`;
	}
	if (lit.data_type !== undefined) {
		const cast = POSTGRES_CAST_FOR_DATA_TYPE[lit.data_type];
		// `${lit.value}` binds as a parameter; `sql.raw(cast)` is safe
		// because the cast token comes from a closed-enum lookup, with
		// no path for an attacker-controlled string to reach the
		// raw-emission slot.
		return sql`${lit.value}::${sql.raw(cast)}`;
	}
	return sql`${lit.value}`;
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
): RawBuilder<SqlBool> {
	const left = compileValueExprAsTerm(pred.left, ctx);
	const lowerOp = pred.lowerInclusive ? ">=" : ">";
	const upperOp = pred.upperInclusive ? "<=" : "<";

	if (pred.lower !== undefined && pred.upper !== undefined) {
		const lower = compileValueExprAsTerm(pred.lower, ctx);
		const upper = compileValueExprAsTerm(pred.upper, ctx);
		return sql<SqlBool>`(${left} ${sql.raw(lowerOp)} ${lower}) and (${left} ${sql.raw(upperOp)} ${upper})`;
	}
	if (pred.lower !== undefined) {
		const lower = compileValueExprAsTerm(pred.lower, ctx);
		return sql<SqlBool>`${left} ${sql.raw(lowerOp)} ${lower}`;
	}
	if (pred.upper !== undefined) {
		const upper = compileValueExprAsTerm(pred.upper, ctx);
		return sql<SqlBool>`${left} ${sql.raw(upperOp)} ${upper}`;
	}
	// Schema's `.refine(...)` rejects this shape at parse; the
	// runtime branch defends against a directly-constructed bypass.
	throw new Error(
		"compilePredicate: 'between' predicate has neither lower nor upper bound — the schema's .refine() should have caught this before reaching the SQL compiler",
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
): RawBuilder<SqlBool> {
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
				`compilePredicate: multi-select-contains accepts only string-typed token literals; received ${typeof v.value} (${String(v.value)}). Multi-select tokens are wire-form strings, and the JSONB key-existence operators (?| / ?&) match by string equality only.`,
			);
		}
		stringValues.push(v.value);
	}

	const operatorToken = quantifierToOperator(pred.quantifier);
	// `text[]`-bound array literal: each element binds as a
	// parameter, the array constructor is a single Postgres
	// expression. Kysely's `${value}` substitution treats arrays as
	// pg's array-binding form natively (not as a stringified blob).
	return sql<SqlBool>`${left} ${sql.raw(operatorToken)} ${stringValues}`;
}

/**
 * Map a multi-select quantifier to its JSONB containment operator
 * token. Closed enum dispatch — the exhaustive switch over
 * `MultiSelectQuantifier` surfaces any new quantifier surface at
 * compile time, so the operator-table here stays in lockstep with
 * the AST union.
 */
function quantifierToOperator(quantifier: MultiSelectQuantifier): string {
	switch (quantifier) {
		case "any":
			return "?|";
		case "all":
			return "?&";
		default: {
			const _exhaustive: never = quantifier;
			throw new Error(
				`compilePredicate: unhandled multi-select quantifier ${String(_exhaustive)}`,
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
): RawBuilder<SqlBool> {
	const propRead = compilePropertyAsText(pred.property, ctx);

	switch (pred.mode) {
		case "starts-with": {
			// Escape LIKE meta-characters so they're matched
			// literally rather than as wildcards. Postgres docs § 9.7
			// "Pattern Matching" — `_` matches any single char, `%`
			// matches any string; `\` is the default escape.
			const escaped = escapeLikeValue(pred.value);
			return sql<SqlBool>`${propRead} like ${`${escaped}%`}`;
		}
		case "fuzzy":
			// pg_trgm `%` operator: returns true if the trigram
			// similarity of the two arguments exceeds
			// `pg_trgm.similarity_threshold` (default 0.3).
			return sql<SqlBool>`${propRead} % ${pred.value}`;
		case "phonetic":
			// Double Metaphone equality. fuzzystrmatch's `dmetaphone`
			// produces a phonetic key; equality on the keys means
			// the two inputs sound alike.
			return sql<SqlBool>`dmetaphone(${propRead}) = dmetaphone(${pred.value})`;
		case "fuzzy-date":
			return compileFuzzyDate(propRead, pred.value);
		default: {
			const _exhaustive: never = pred.mode;
			throw new Error(
				`compilePredicate: unhandled match mode ${String(_exhaustive)}`,
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
): RawBuilder<unknown> {
	// Delegate the JSONB-vs-scalar dispatch and via-routing to
	// compileTerm; wrap the result in `::text` regardless of the
	// underlying data_type cast. The compileTerm output is already
	// a properly-typed expression for the column's `data_type`; the
	// outer `::text` cast lifts whatever shape it produced into the
	// text domain that pg_trgm / fuzzystrmatch / LIKE all expect.
	const propExpr = compileTerm(property, ctx);
	return sql`(${propExpr})::text`;
}

/**
 * Escape Postgres `LIKE` metacharacters so they're matched
 * literally. The default escape character is `\`; replacing each
 * `\` first defends against double-escaping (the user's literal
 * `\` would otherwise become an escape token after `%` and `_` are
 * escaped). Postgres docs § 9.7 "Pattern Matching" — `_` matches
 * any single character, `%` matches any string, and the escape
 * character is `\` unless overridden via `LIKE pattern ESCAPE
 * '<char>'`.
 */
function escapeLikeValue(value: string): string {
	return value.replace(/\\/g, "\\\\").replace(/%/g, "\\%").replace(/_/g, "\\_");
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
	propRead: RawBuilder<unknown>,
	value: string,
): RawBuilder<SqlBool> {
	const permutations = generateDatePermutations(value);
	if (permutations.length === 0) {
		// Defensive: the input passed `match.value`'s `.min(1)` but
		// failed the YYYY-MM-DD shape. Throw a clear error rather
		// than emit `<prop> IN ()` (a Postgres syntax error).
		throw new Error(
			`compilePredicate: fuzzy-date mode requires a YYYY-MM-DD value, got '${value}'`,
		);
	}
	return sql<SqlBool>`${propRead} in (${sql.join(permutations.map((p) => sql`${p}`))})`;
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
 * `compileValueExprAsTerm` helper admits the `term` arm (a `prop` /
 * `input` / `session-user` / `session-context` / `literal` reading
 * the same wire-form geopoint string) and throws on every non-term
 * arm so the expression-compiler integration boundary surfaces at
 * the call site.
 */
function compileWithinDistance(
	pred: Extract<Predicate, { kind: "within-distance" }>,
	ctx: PredicateCompileContext,
): RawBuilder<SqlBool> {
	// Property side: read the geopoint string as text, then split
	// out lat/lon via split_part. compileTerm reads `geopoint` as
	// text per `POSTGRES_CAST_FOR_DATA_TYPE`, so the outer `::text`
	// cast is structurally redundant but documents the type at the
	// split site.
	const propText = compileTerm(pred.property, ctx);
	const propLat = sql`split_part((${propText})::text, ' ', 1)::numeric`;
	const propLon = sql`split_part((${propText})::text, ' ', 2)::numeric`;

	// Center side: same split shape. The center expression compiles
	// through the term bridge, so a typed-literal center
	// (`literal("42.37 -71.11 0 0", "text")`) or a search-input ref
	// (`input("user_location")` bound at runtime) both work.
	const centerText = compileValueExprAsTerm(pred.center, ctx);
	const centerLat = sql`split_part((${centerText})::text, ' ', 1)::numeric`;
	const centerLon = sql`split_part((${centerText})::text, ' ', 2)::numeric`;

	// Distance conversion: AST radius × per-unit meters factor.
	// Pre-computed at compile time because PostGIS's `ST_DWithin`
	// expects meters as a scalar, and the AST's per-unit factor
	// is closed-set ({miles, kilometers}) — no runtime branching.
	const distanceMeters = pred.distance * unitToMeters(pred.unit);

	return sql<SqlBool>`st_dwithin(st_makepoint(${propLon}, ${propLat})::geography, st_makepoint(${centerLon}, ${centerLat})::geography, ${distanceMeters})`;
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
				`compilePredicate: unhandled distance unit ${String(_exhaustive)}`,
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
): RawBuilder<SqlBool> {
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
			"compilePredicate: unreachable — non-self relation path produced a 'self' compiled result",
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

	// Correlation: leaf subquery's `anchor_case_id` equals the outer
	// anchor's `case_id`. The leaf subquery exposes
	// `anchor_case_id` per its `RelationPathLeafRow` shape — see
	// `compileRelationPath.ts`'s leaf-shape JSDoc.
	const correlation = sql`${sql.ref(`${compiledPath.leafAlias}.anchor_case_id`)} = ${sql.ref(`${ctx.anchorAlias}.case_id`)}`;
	const wherePart =
		innerWhere !== undefined ? sql` and (${innerWhere})` : sql``;

	const subquery = sql`select 1 from ${compiledPath.buildLeafSubquery()} where ${correlation}${wherePart}`;

	return mode === "exists"
		? sql<SqlBool>`exists (${subquery})`
		: sql<SqlBool>`not exists (${subquery})`;
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
): RawBuilder<SqlBool> {
	if (mode === "exists") {
		// `exists(self)` → trivial-true; `exists(self, where)` →
		// `where` directly.
		return where === undefined
			? sql<SqlBool>`true`
			: compilePredicate(where, ctx);
	}
	// `missing(self)` → trivial-false; `missing(self, where)` →
	// `NOT (where)`.
	return where === undefined
		? sql<SqlBool>`false`
		: sql<SqlBool>`not (${compilePredicate(where, ctx)})`;
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
): RawBuilder<SqlBool> {
	const isBound = ctx.bindings.searchInputs?.has(pred.input.name) ?? false;
	if (isBound) {
		return compilePredicate(pred.clause, ctx);
	}
	// Input not bound — short-circuit to "match every row".
	return sql<SqlBool>`true`;
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
): RawBuilder<SqlBool> {
	if (left.kind !== "term") {
		throw new Error(
			`compilePredicate '${op}' accepts only term-arm ValueExpression operands; received kind '${left.kind}'. Compile non-term ValueExpression operands through the sibling expression compiler before passing them to compilePredicate.`,
		);
	}
	const term = left.term;

	// Property-ref dispatch — the only path with a meaningful
	// strict-absent semantic at the storage layer.
	if (term.kind === "prop") {
		return compilePropertyAbsenceCheck(term, ctx, op);
	}

	// Non-property term — fall back to the standard scalar shape.
	// Three sub-cases (input / session-user / session-context /
	// literal) all share the same `<term> IS NULL` shape; the
	// blank form adds `OR <term> = ''`.
	const termExpr = compileTerm(term, ctx);
	if (op === "is-null") {
		return sql<SqlBool>`${termExpr} is null`;
	}
	return sql<SqlBool>`${termExpr} is null or ${termExpr} = ''`;
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
): RawBuilder<SqlBool> {
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
			return sql<SqlBool>`${valueRead} is null`;
		}
		return sql<SqlBool>`${valueRead} is null or ${valueRead} = ''`;
	}

	// Self-via dispatch — the JSONB key-existence shape for
	// JSONB-document properties; the standard `IS NULL` / `OR <col> =
	// ''` shape for reserved scalar columns. Reserved scalar columns
	// live outside the JSONB document, so the `?` operator does not
	// apply.
	const sourceAlias = ctx.anchorAlias;
	if (RESERVED_SCALAR_COLUMNS.has(propertyName)) {
		const columnRef = sql.ref(`${sourceAlias}.${propertyName}`);
		if (op === "is-null") {
			return sql<SqlBool>`${columnRef} is null`;
		}
		return sql<SqlBool>`${columnRef} is null or ${columnRef} = ''`;
	}

	// JSONB-document property: key-existence test plus the
	// optional empty-string disjunction. The `?` operator returns
	// boolean (the key-exists semantic); negation with `NOT (...)`
	// matches strict-absent. The blank form adds `OR
	// (<source>.properties->>'<key>') = ''` for absent-or-empty.
	const propertiesRef = sql.ref(`${sourceAlias}.properties`);
	if (op === "is-null") {
		return sql<SqlBool>`not (${propertiesRef} ? ${propertyName})`;
	}
	return sql<SqlBool>`not (${propertiesRef} ? ${propertyName}) or (${propertiesRef} ->> ${propertyName}) = ''`;
}
