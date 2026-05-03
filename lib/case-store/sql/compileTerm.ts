// lib/case-store/sql/compileTerm.ts
//
// Compile a `Term` AST node to a Kysely expression. The predicate
// compiler and expression compiler consume this module's output as
// the leaf of every operator they emit — `eq(left, right)` reduces
// to `compileTerm(left) = compileTerm(right)`, `match(prop, value)`
// reduces to a `pg_trgm` operator over `compileTerm(prop)`, and so
// on.
//
// ## Term arms and emission shape
//
//   - `prop` — typed JSONB read from the anchor's `properties`
//     column (or the relation-path leaf alias when the term carries
//     a non-self `via`). The four reserved scalar columns
//     (`case_id`, `case_type`, `owner_id`, `status`) read from
//     dedicated columns rather than through JSONB.
//   - `literal` — primitive constant. Strings / numbers / booleans
//     bind via Kysely's parameter channel; `null` emits as the SQL
//     literal `NULL`. When the literal carries a `data_type` (date,
//     datetime, time), the cast is applied at the parameter so
//     comparisons against typed property reads stay well-typed on
//     both sides.
//   - `input` / `session-user` / `session-context` — runtime
//     bindings resolved from the `bindings` map on the
//     `TermCompileContext`. These arms are runtime-required: a
//     missing binding at compile time is a misuse, and the compiler
//     throws rather than silently emit a `NULL` parameter.
//
// ## JSONB property-read operators
//
// Postgres distinguishes two JSONB property-read operators:
//
//   - `->>` returns the value as `text`. The compiler uses this
//     for every scalar `data_type` (`text`, `int`, `decimal`,
//     `date`, `time`, `datetime`, `single_select`, `geopoint`)
//     and applies a Postgres cast (`cast(<expr> as integer)`,
//     `cast(<expr> as numeric)`, `cast(<expr> as date)`, etc.) to
//     lift the text value into the typed comparison world. Cast
//     emission goes through Kysely's typed `eb.cast<T>(expr,
//     dataType)` helper. Verified at the Postgres docs reference
//     at `https://www.postgresql.org/docs/18/functions-json.html`
//     — "JSON Object Field as Text" returns `text`.
//   - `->` returns the value as `jsonb`. The compiler uses this
//     for `multi_select` because the predicate compiler's
//     `multi-select-contains` arm needs the JSONB array on the
//     left-hand side of `?|` / `?&` / `@>`. Reading via `->>`
//     yields a stringified JSON blob the JSONB operators can't
//     operate on.
//
// ## Non-self via reads as scalar subqueries
//
// When a `prop` carries a non-self `via`, the term compiler
// builds the relation-path leaf via `compileRelationPath` and
// emits a correlated scalar subquery: `(select cast(<leaf>.
// properties ->> 'name' as <type>) from <leaf-aliased-expr>
// where <leaf>.anchor_case_id = <ctx.anchorAlias>.case_id limit
// 1)`. The subquery correlates back to the outer anchor, applies
// the via's join chain, and returns the property value at the
// walk's destination. `LIMIT 1` keeps the result scalar — the
// AST authoring surface for term-level non-self vias targets the
// 1-to-1 walk shape (parent / host etc.); a many-to-one walk
// returns the first matching row.
//
// The wider compiler (predicate compiler's comparison / membership
// operators; expression compiler's arithmetic / conditional /
// concat operators) consumes the term compiler's output as a
// generic value-bearing expression — the scalar-subquery shape
// composes without additional wrapping.
//
// ## Tenant scoping
//
// The `appId` / `ownerId` fields on `TermCompileContext` are part
// of the context surface so callers thread one consistent context
// across every compiler in the pipeline (term, predicate,
// expression, relation-path). The term compiler itself does not
// emit a tenant filter — tenant filtering belongs at the layer
// that emits the outer query's `cases` read (the predicate
// compiler, the expression compiler, the case-list query), not at
// every term-read site. Surfacing the fields anyway keeps the
// context shape uniform for inspection and for forwarding into
// `compileRelationPath` when a non-self `via` arrives.
//
// ## Why `AliasableExpression<unknown>` is the public return type
//
// Every arm produces a value-bearing operand — JSONB read, scalar
// column reference, parameter binding, or correlated scalar
// subquery. `AliasableExpression<T>` is Kysely's generic operand
// contract that also exposes `.as(alias)`; every concrete return
// shape (`ExpressionWrapper`, `RawBuilder`, `SelectQueryBuilder`)
// implements it. The wider compilers (predicate, expression,
// integrating callers) consume the result through `eb(...)`,
// `eb.selectFrom(...).where(...)`, and the `where(...)` clause's
// `Expression<SqlBool>` accepting surface — each accepts any
// `Expression<T>` of the right type. Tests call `.as("v")` against
// the returned value to wrap it in a select column; surfacing
// `AliasableExpression` (rather than the bare `Expression`) keeps
// that call site type-checked at the public boundary.

import type { AliasableExpression, Kysely } from "kysely";
import { expressionBuilder } from "kysely";
import type { CasePropertyDataType, CaseType } from "@/lib/domain";
import {
	compilerBugMessage,
	typeCheckerBypassMessage,
	unhandledKindMessage,
} from "@/lib/domain/predicate/errors";
import type { RelationPath, Term } from "@/lib/domain/predicate/types";
import { compileLiteral } from "./compileLiteral";
import { compileRelationPath } from "./compileRelationPath";
import type { Database } from "./database";
import {
	JSONB_READ_OPERATOR_FOR_DATA_TYPE,
	POSTGRES_CAST_FOR_DATA_TYPE,
} from "./dataTypeTokens";

// ---------------------------------------------------------------
// Reserved scalar columns
// ---------------------------------------------------------------

/**
 * The four columns on `cases` that surface as first-class scalar
 * columns rather than as JSONB-document keys. A `prop` term whose
 * `property` matches one of these names reads from the scalar
 * column directly via `eb.ref(...)`, both because the column is
 * indexed (the JSONB read skips the index) and because the column
 * is not present in the JSONB document (the read returns `NULL`).
 *
 * The other scalar columns on `cases` (`opened_on` / `modified_on`
 * / `closed_on` / `parent_case_id`) are intentionally NOT routed
 * through `prop` at the term layer. They are timestamp / FK columns
 * whose authoring surface belongs to query-shape primitives (sort
 * order, opened-vs-closed filter, parent navigation) rather than to
 * the case's authored property document. Any future term-level
 * support for those columns gets a dedicated AST shape rather than
 * `prop`-as-scalar overloading.
 *
 * **Shadowing caveat:** these names are also valid CommCare case-
 * property identifiers (the `casePropertyField` validator on
 * `propertyRefSchema.property` admits any
 * `[a-zA-Z][a-zA-Z0-9_-]*` shape). A blueprint that declares a
 * property literally named `case_id` / `case_type` / `owner_id` /
 * `status` will be silently shadowed by the scalar-column read
 * here — the term compiler reads from the scalar column instead
 * of the JSONB document the blueprint author intended. The
 * blueprint validator is responsible for rejecting these names
 * (CommCare's wire layer also reserves them, so the blueprint
 * validator's rejection is independently load-bearing); the term
 * compiler trusts that rejection upstream and routes uniformly.
 * If the blueprint validator gains a per-property reservation
 * check, this set is the source of truth for the four names.
 */
const RESERVED_SCALAR_COLUMNS: ReadonlySet<string> = new Set([
	"case_id",
	"case_type",
	"owner_id",
	"status",
]);

// ---------------------------------------------------------------
// Public types
// ---------------------------------------------------------------

/**
 * The set of value types Postgres can bind safely as parameter
 * values from runtime bindings. `Date` is included for
 * `appversion` / `deviceid`-style timestamp values some session
 * surfaces materialize as native `Date` objects; pg-driver
 * serializes those to ISO strings on the wire. Plain object /
 * array values are intentionally NOT admitted — the wire target
 * for a runtime binding is a single scalar; structured payloads
 * indicate a layer-violation upstream and should fail at the
 * type boundary rather than silently flow through.
 */
export type TermBindingValue = string | number | boolean | Date | null;

/**
 * Runtime bindings for the three non-property `Term` arms.
 *
 * Each arm of the term AST that resolves at runtime (search-input
 * value, session-user data field, session-context field) reads
 * from a dedicated map. Splitting the maps by AST arm rather than
 * collapsing them into one keyed by string preserves the same
 * authoring discipline the AST itself encodes — a `sessionUser`
 * ref must not silently resolve from the search-input map, and
 * vice versa, because the wire targets resolve those fields from
 * different instances on `commcaresession`.
 *
 * All three maps are optional. A term that references a missing
 * binding throws a clear error at compile time (rather than emit
 * a `NULL` parameter) — runtime bindings are required-by-position;
 * the wider compiler must thread the runtime values in before
 * calling the term compiler.
 *
 * The value type narrows to `TermBindingValue` so that future
 * callers threading a structured payload (e.g. a JSON object for
 * a complex search input) hit a type error at the boundary rather
 * than a runtime serialization failure inside pg-driver.
 */
export interface TermBindings {
	/**
	 * Search-input values keyed by input name. The wider case-list
	 * pipeline reads input values from the request boundary (the
	 * search form's submitted fields) and threads them in here.
	 */
	searchInputs?: ReadonlyMap<string, TermBindingValue>;

	/**
	 * Open-namespace user-data fields keyed by field name. The
	 * wider pipeline reads these from the authenticated session's
	 * Better Auth user record's `additionalFields` (or the
	 * compatible CommCare custom-user-data map for HQ-imported
	 * sessions).
	 */
	sessionUser?: ReadonlyMap<string, TermBindingValue>;

	/**
	 * Closed-namespace context fields keyed by field name (one of
	 * `userid` / `username` / `deviceid` / `appversion`, per
	 * `SESSION_CONTEXT_FIELDS` in the predicate types). The wider
	 * pipeline reads these from the request session — `userid` is
	 * `session.user.id`, `appversion` is the active app's version,
	 * etc.
	 */
	sessionContext?: ReadonlyMap<string, TermBindingValue>;
}

/**
 * The compile context every `compileTerm` call requires.
 *
 * Object-args by convention (per the standing rule about
 * positional same-type arguments). Threading one context across
 * every layer of the compiler stack — term, predicate, expression,
 * relation-path — keeps the runtime data flow uniform.
 */
export interface TermCompileContext {
	/**
	 * The Kysely Database handle. Used to construct expression-
	 * builder calls (`eb.ref(...)`, `eb.lit(...)`) and to forward
	 * into a downstream `compileRelationPath` call when a non-self
	 * `via` is present.
	 */
	db: Kysely<Database>;

	/**
	 * The owning app — first half of the `(app_id, owner_id)`
	 * tenant pair. The term compiler does not emit a tenant filter
	 * itself; the field exists on the context so callers can
	 * forward the same context to `compileRelationPath` (which
	 * does emit the filter on every joined `cases` row).
	 */
	appId: string;

	/**
	 * The owning user — second half of the tenant pair. `null` is
	 * admitted because HQ-imported cases pre-assignment carry a
	 * null owner. Same forwarding rationale as `appId`.
	 */
	ownerId: string | null;

	/**
	 * The alias the caller's outer query uses for the `cases`
	 * table. Property reads with `via: self` (or no `via`) emit
	 * `<anchorAlias>.properties ->> '<key>'` (or `<anchorAlias>.<col>`
	 * for reserved scalar columns); property reads with non-self
	 * `via` build their own relation-path leaf subquery and
	 * correlate `<leaf>.anchor_case_id = <anchorAlias>.case_id`.
	 */
	anchorAlias: string;

	/**
	 * The relation-walk nesting depth at this compile site. Zero
	 * at the outermost compile; incremented by consumers that
	 * recurse into a relation-walk leaf's inner `where` predicate.
	 * Optional; defaults to 0 when callers do not thread it.
	 *
	 * The depth is forwarded to `compileRelationPath` calls inside
	 * non-self via prop reads so the resulting leaf subquery uses
	 * a unique alias (`rp_leaf_<depth>`) that does not shadow
	 * outer-scope leaves with the same name. SQL identifier
	 * resolution reads the innermost matching alias first; a
	 * shadowed outer alias would silently break correlation.
	 */
	relationPathDepth?: number;

	/**
	 * Schema lookup for property-type → Postgres-cast mapping.
	 * Keyed by case-type name. The compiler resolves a `prop`
	 * term's `caseType` against this map, then resolves
	 * `property` against the case type's `properties[]` to find
	 * the declared `data_type` and pick the cast.
	 *
	 * A missing case type or a property absent from the looked-up
	 * case type's schema is a bug at the type-checker layer that
	 * should never reach the SQL compiler — the term compiler
	 * throws a clear error rather than emit ambiguous SQL.
	 */
	caseTypeSchemas: ReadonlyMap<string, CaseType>;

	/**
	 * Runtime bindings for the three non-property `Term` arms. See
	 * `TermBindings` for per-arm semantics.
	 */
	bindings: TermBindings;
}

// ---------------------------------------------------------------
// Shared expression builder
// ---------------------------------------------------------------

/**
 * The standalone expression builder bound to the case-store
 * `Database` type with every table in scope. Used by every compiler
 * helper below to construct typed operands without threading a
 * Kysely callback through each call site. Kysely's
 * `expressionBuilder<DB, TB>()` factory returns a builder whose
 * `eb.ref(...)` / `eb.cast(...)` / `eb.val(...)` calls type-check
 * against `DB[TB]` columns; with `TB = keyof Database` the
 * builder accepts column references through any of the three
 * tables (`cases`, `case_type_schemas`, `case_indices`).
 *
 * Strings carrying a runtime alias prefix (`<anchorAlias>.case_id`,
 * `<leafAlias>.properties`) read as `Database`-table-qualified
 * `${alias}.${column}` references through the type-erased local
 * helpers below — TS cannot enumerate the runtime alias accumulation
 * but the runtime values are always table aliases for the same
 * tables in the typed scope.
 */
const eb = expressionBuilder<Database, keyof Database>();

// ---------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------

/**
 * Compile a `Term` AST node to a Kysely expression.
 *
 * Term-arm dispatch:
 *
 *   - `prop` → JSONB read with cast (or scalar column read for the
 *     four reserved columns), routed through the anchor alias for
 *     self-via reads or through the relation-path leaf alias for
 *     non-self-via reads.
 *   - `literal` → typed parameter binding for non-null primitives
 *     (lifted into the declared `data_type` cast when the literal
 *     carries one), or the SQL `NULL` keyword for the null literal.
 *   - `input` / `session-user` / `session-context` → parameter
 *     binding from the corresponding `bindings` map; throws a
 *     clear error when the binding is missing.
 *
 * The return type is `AliasableExpression<unknown>` — Kysely's
 * `.as(alias)`-bearing operand contract that every concrete return
 * shape (`ExpressionWrapper`, `RawBuilder`, `SelectQueryBuilder`)
 * implements. Consumers (predicate / expression compilers,
 * integrating callers) thread the result into `eb(left, op, right)`
 * binary operations and `where(...)` clauses uniformly; the
 * select-column tests in this package call `.as("v")` against the
 * returned value to wrap it in a select column.
 *
 * The `unknown` payload is deliberate — each arm resolves to a
 * different per-Postgres-type expression but the runtime dispatches
 * by `term.kind`, and the wider compilers consume the return as a
 * generic operand.
 */
export function compileTerm(
	term: Term,
	ctx: TermCompileContext,
): AliasableExpression<unknown> {
	switch (term.kind) {
		case "prop":
			return compilePropertyRef(term, ctx);
		case "literal":
			return compileLiteral(term);
		case "input":
			return compileBoundRef(
				term.name,
				ctx.bindings.searchInputs,
				`search input '${term.name}'`,
			);
		case "session-user":
			return compileBoundRef(
				term.field,
				ctx.bindings.sessionUser,
				`session user field '${term.field}'`,
			);
		case "session-context":
			return compileBoundRef(
				term.field,
				ctx.bindings.sessionContext,
				`session context field '${term.field}'`,
			);
		default: {
			const _exhaustive: never = term;
			throw new Error(
				unhandledKindMessage({
					where: "compileTerm",
					family: "Term",
					received: (_exhaustive as { kind?: unknown })?.kind ?? _exhaustive,
					knownKinds: [
						"prop",
						"literal",
						"input",
						"session-user",
						"session-context",
					],
				}),
			);
		}
	}
}

// ---------------------------------------------------------------
// `prop` — property reference compiler
// ---------------------------------------------------------------

/**
 * Compile a `prop` term to a Kysely expression.
 *
 * Three branches:
 *
 *   1. The property is one of the four reserved scalar columns
 *      (`case_id`, `case_type`, `owner_id`, `status`) — read
 *      directly off the column or out of the via's leaf subquery
 *      (the leaf row exposes every `cases` column).
 *   2. `via` is absent or `selfPath()` (the no-traversal degenerate)
 *      — JSONB read off the anchor alias's `properties` column.
 *      The property's `data_type` is resolved on the originating
 *      case type (`term.caseType`).
 *   3. `via` is a non-self relation walk — the term compiler
 *      builds the leaf subquery via `compileRelationPath` and
 *      emits a correlated scalar subquery: `(select
 *      cast(<leaf>.properties ->> 'name' as <type>) from
 *      <leaf-aliased-expr> where <leaf>.anchor_case_id =
 *      <ctx.anchorAlias>.case_id limit 1)`. The subquery applies
 *      the via's join chain inside its own SQL scope and
 *      correlates back to the outer anchor.
 *      The property's `data_type` is resolved on the destination
 *      case type (NOT on `term.caseType`, which is the originating
 *      scope per the AST contract on `propertyRefSchema.caseType`).
 *      `LIMIT 1` keeps the result scalar — the AST authoring
 *      surface for term-level non-self vias targets the 1-to-1
 *      walk shape (parent / host); a many-to-one walk returns the
 *      first matching row.
 */
function compilePropertyRef(
	term: Extract<Term, { kind: "prop" }>,
	ctx: TermCompileContext,
): AliasableExpression<unknown> {
	const { caseType, property, via } = term;
	const isSelfVia = via === undefined || via.kind === "self";

	if (isSelfVia) {
		return compileSelfViaPropertyRef({
			anchorAlias: ctx.anchorAlias,
			caseType,
			property,
			schemas: ctx.caseTypeSchemas,
		});
	}

	// Non-self via: build the relation-path leaf and emit a
	// correlated scalar subquery. The destination case type is
	// resolved by walking the via's chain from the originating
	// scope — that destination is where the property's `data_type`
	// (and so the cast / read operator) lives.
	return compileNonSelfViaPropertyRef({
		via,
		anchorAlias: ctx.anchorAlias,
		caseType,
		property,
		ctx,
	});
}

/**
 * Compile a self-via property read: a JSONB or scalar-column read
 * off the anchor's `cases` row. Reserved scalar columns bypass
 * the JSONB document entirely; everything else reads through the
 * `properties` column with the per-`data_type` cast.
 *
 * The function is a thin wrapper around the column-emission
 * helpers below. Splitting the self-via and non-self-via shapes
 * into separate functions keeps each call site's intent clear and
 * lets the non-self-via helper reuse the column-emission logic
 * inside the scalar-subquery body.
 */
function compileSelfViaPropertyRef(args: {
	anchorAlias: string;
	caseType: string;
	property: string;
	schemas: ReadonlyMap<string, CaseType>;
}): AliasableExpression<unknown> {
	const { anchorAlias, caseType, property, schemas } = args;
	if (RESERVED_SCALAR_COLUMNS.has(property)) {
		return scalarColumnRef(anchorAlias, property);
	}
	const dataType = lookupDataType(caseType, property, schemas);
	return jsonbColumnRead({ sourceAlias: anchorAlias, property, dataType });
}

/**
 * Compile a non-self via property read as a correlated scalar
 * subquery over the relation-path leaf. The leaf is built via
 * `compileRelationPath` against the via; the subquery correlates
 * `<leaf>.anchor_case_id = <ctx.anchorAlias>.case_id` and reads
 * the destination property out of the leaf row.
 *
 * The relation-path depth on the surrounding context is forwarded
 * unchanged to `compileRelationPath` — the per-call leaf alias
 * carries the depth suffix so a nested term-level walk does not
 * shadow an outer relation-path leaf with the same name.
 */
function compileNonSelfViaPropertyRef(args: {
	via: RelationPath;
	anchorAlias: string;
	caseType: string;
	property: string;
	ctx: TermCompileContext;
}): AliasableExpression<unknown> {
	const { via, anchorAlias, caseType, property, ctx } = args;

	// Resolve the destination case type the walk reaches. The
	// `data_type` of the read property lives on the destination,
	// NOT on the originating `caseType` — the AST contract pins
	// this on `propertyRefSchema.caseType` (the originating scope).
	const lookupCaseType = resolveDestinationCaseType(
		via,
		caseType,
		ctx.caseTypeSchemas,
	);

	// Build the leaf subquery. `compileRelationPath` is exhaustive
	// over `RelationPath`; the runtime narrows to `kind: "joined"`
	// for every non-self via. `kind: "self"` is unreachable here
	// because `isSelfVia` is the upstream branch.
	const compiledPath = compileRelationPath(via, {
		db: ctx.db,
		appId: ctx.appId,
		ownerId: ctx.ownerId,
		anchorAlias,
		relationPathDepth: ctx.relationPathDepth ?? 0,
	});
	if (compiledPath.kind !== "joined") {
		throw new Error(
			compilerBugMessage({
				where: "compileTerm.compileNonSelfViaPropertyRef",
				invariant:
					"a non-`self` `RelationPath` produced a `self` compiled result",
				detail:
					"The upstream `isSelfVia` branch in `compilePropertyRef` is supposed to route every `self` walk away from this helper before it reaches `compileRelationPath`. Reaching this throw means `compileRelationPath` returned the degenerate `self` marker for a `RelationPath` whose `kind` is not `self` — a contract violation between the two helpers.",
			}),
		);
	}

	// Inner column-read inside the subquery body. Reserved scalars
	// read directly off the leaf alias; everything else reads the
	// JSONB `properties` column with the per-data-type cast.
	const leafAlias = compiledPath.leafAlias;
	const innerRead = RESERVED_SCALAR_COLUMNS.has(property)
		? scalarColumnRef(leafAlias, property)
		: jsonbColumnRead({
				sourceAlias: leafAlias,
				property,
				dataType: lookupDataType(lookupCaseType, property, ctx.caseTypeSchemas),
			});

	// Correlated scalar subquery: select the read expression from
	// the aliased leaf with a correlation predicate to the outer
	// anchor's `case_id`. `LIMIT 1` keeps the result scalar — the
	// term compiler's contract is "value-bearing expression";
	// without `LIMIT 1`, a multi-row leaf would surface as a
	// "more than one row returned by a subquery used as an
	// expression" runtime error.
	//
	// Type-erased local view via `DynamicCorrelatedQuery` because TS
	// cannot enumerate the runtime alias through the typed builder
	// — the leaf alias is `${RELATION_PATH_LEAF_ALIAS}` at depth 0
	// and `${RELATION_PATH_LEAF_ALIAS}_<N>` at deeper nestings, both
	// runtime-derived. Each method call's `<alias>.<column>` strings
	// resolve at runtime against the leaf row's actual columns,
	// which match `RelationPathLeafRow`'s shape by construction;
	// the cast at the boundary pins the public `Expression<unknown>`
	// contract.
	const leafSubquery = compiledPath.buildLeafSubquery();
	const innerQuery = ctx.db.selectFrom(
		leafSubquery as unknown as never,
	) as unknown as DynamicCorrelatedQuery;
	const correlated = innerQuery
		.whereRef(`${leafAlias}.anchor_case_id`, "=", `${anchorAlias}.case_id`)
		.select(innerRead.as("v"))
		.limit(1);
	return correlated as unknown as AliasableExpression<unknown>;
}

/**
 * Emit a JSONB property read with the per-data-type cast and
 * read operator. Shared between self-via and non-self-via
 * dispatch — both paths read JSONB documents the same way, only
 * the source alias differs.
 *
 * Composition: `eb.cast<T>(eb(<properties-ref>, <readOp>, <key>),
 * <cast>)`. The inner binary expression reads the JSONB key via
 * `->>` (text) or `->` (jsonb); the outer cast lifts the read into
 * the typed Postgres value the predicate / expression compilers
 * compare against. Both `readOp` and `cast` come from closed-enum
 * lookups keyed on `CasePropertyDataType`, so the typed builder's
 * accepted-string-literal surfaces are uniformly satisfied.
 */
function jsonbColumnRead(args: {
	sourceAlias: string;
	property: string;
	dataType: CasePropertyDataType;
}): AliasableExpression<unknown> {
	const { sourceAlias, property, dataType } = args;
	const cast = POSTGRES_CAST_FOR_DATA_TYPE[dataType];
	const readOperator = JSONB_READ_OPERATOR_FOR_DATA_TYPE[dataType];
	const propertiesRef = `${sourceAlias}.properties` as const;
	// Type-erased binary-op call: the runtime alias prefix produces
	// a string the typed builder cannot enumerate against
	// `Database`. The runtime call resolves correctly because the
	// alias names a `cases` (or `cases`-shaped leaf) row at every
	// concrete site; the cast pins the public expression type.
	const jsonRead = (eb as DynamicExprBuilder)(
		propertiesRef,
		readOperator,
		property,
	);
	return eb.cast(jsonRead, cast);
}

/**
 * Emit a reserved scalar column reference (`<alias>.<column>`).
 * Used both for self-via reads off the anchor alias and for
 * non-self-via reads off the relation-path leaf alias. The runtime
 * alias prefix is type-erased through `DynamicExprBuilder` because
 * the typed builder cannot enumerate `${alias}.${column}` against
 * `Database`'s static column set; the actual alias names a
 * `cases`-shaped row at every concrete site, so the runtime
 * column reference is well-formed.
 */
function scalarColumnRef(
	alias: string,
	column: string,
): AliasableExpression<unknown> {
	return (eb as DynamicExprBuilder).ref(`${alias}.${column}`);
}

/**
 * Resolve the destination case-type name a `RelationPath` reaches.
 *
 * The three non-`self` AST kinds map to two resolution shapes:
 *
 *   - `ancestor` — walk the `parent_type` chain, one hop per
 *     `RelationStep`. Each hop's destination is the previous origin's
 *     `parent_type`; the first hop's origin is `originCaseType`.
 *   - `subcase` / `any-relation` — find the case type whose
 *     `parent_type` is `originCaseType`. `ofCaseType` selects when
 *     present; with no qualifier and exactly one candidate the
 *     unique candidate wins.
 *
 * The `self` kind is handled by upstream callers (which short-circuit
 * before invoking this helper) — the body's `case "self"` arm throws
 * a compiler-bug message to surface any caller that routes `self`
 * through an untyped boundary. Mirrors `checkRelationPath` in
 * `lib/domain/predicate/typeChecker.ts:1080-1232`.
 */
function resolveDestinationCaseType(
	via: RelationPath,
	originCaseType: string,
	schemas: ReadonlyMap<string, CaseType>,
): string {
	switch (via.kind) {
		case "self":
			throw new Error(
				compilerBugMessage({
					where: "compileTerm.resolveDestinationCaseType",
					invariant: "a `self` `RelationPath` reached the destination resolver",
					detail:
						"`self` walks have no destination distinct from the originating scope, so callers branch on `kind === 'self'` upstream and use `originCaseType` directly. Reaching this throw means the upstream branch was skipped — the resolver was called with a `self` input it cannot resolve.",
				}),
			);

		case "ancestor": {
			let current = originCaseType;
			for (let i = 0; i < via.via.length; i++) {
				const step = via.via[i];
				const ct = schemas.get(current);
				if (ct === undefined) {
					throw new Error(
						typeCheckerBypassMessage({
							where: "compileTerm.resolveDestinationCaseType",
							summary: `ancestor walk references unknown case type \`${current}\` at hop ${i}`,
							expected:
								"a case type registered in the schema set passed to the compiler",
							received: `\`${current}\``,
							hint: "verify the case type exists in `case_type_schemas` for this app, or correct the AST so the walk reads through declared case types only.",
						}),
					);
				}
				if (!ct.parent_type) {
					throw new Error(
						typeCheckerBypassMessage({
							where: "compileTerm.resolveDestinationCaseType",
							summary: `ancestor walk reached case type \`${current}\` at hop ${i}, but \`${current}\` declares no \`parent_type\``,
							expected: `\`${current}.parent_type\` set to the case type one hop up the ancestor chain`,
							received: `\`${current}.parent_type\` is unset (the chain dead-ends here)`,
							hint: `add a \`parent_type\` to case type \`${current}\` to make the walk well-formed, or shorten the ancestor chain so it terminates at \`${current}\`.`,
						}),
					);
				}
				if (
					step.throughCaseType !== undefined &&
					step.throughCaseType !== ct.parent_type
				) {
					throw new Error(
						typeCheckerBypassMessage({
							where: "compileTerm.resolveDestinationCaseType",
							summary: `\`throughCaseType\` qualifier on ancestor step ${i} disagrees with \`${current}.parent_type\``,
							expected: `\`throughCaseType: '${ct.parent_type}'\` (the declared \`parent_type\` of \`${current}\`)`,
							received: `\`throughCaseType: '${step.throughCaseType}'\``,
							hint: "remove the qualifier (the chain is unambiguous without it) or correct it to match the declared `parent_type`.",
						}),
					);
				}
				current = ct.parent_type;
			}
			return current;
		}

		case "subcase":
		case "any-relation": {
			if (via.ofCaseType !== undefined) {
				return via.ofCaseType;
			}
			// Find the unique case type naming the origin as parent.
			// The ambiguous and zero-candidate cases mean the type
			// checker accepted an under-qualified walk it shouldn't
			// have; the SQL compiler can't disambiguate, so it
			// throws.
			const candidates: string[] = [];
			for (const ct of schemas.values()) {
				if (ct.parent_type === originCaseType) {
					candidates.push(ct.name);
				}
			}
			if (candidates.length === 1) {
				return candidates[0];
			}
			throw new Error(
				typeCheckerBypassMessage({
					where: "compileTerm.resolveDestinationCaseType",
					summary:
						candidates.length === 0
							? `\`${via.kind}\` walk from origin \`${originCaseType}\` has no destination — no case type declares \`parent_type: '${originCaseType}'\``
							: `\`${via.kind}\` walk from origin \`${originCaseType}\` is ambiguous — \`ofCaseType\` is required to disambiguate the destination`,
					expected:
						candidates.length === 0
							? `at least one case type whose \`parent_type\` is \`${originCaseType}\`, or an explicit \`ofCaseType\` qualifier on the walk`
							: `an explicit \`ofCaseType\` qualifier naming one of the candidate case types`,
					received:
						candidates.length === 0
							? `no case type declares \`parent_type: '${originCaseType}'\``
							: `${candidates.length} candidate case types: ${candidates.map((c) => `\`${c}\``).join(", ")}`,
					hint:
						candidates.length === 0
							? `add a child case type whose \`parent_type\` is \`${originCaseType}\`, or replace the walk with a different \`RelationPath\` shape.`
							: "set `ofCaseType` on the walk to select the intended destination case type.",
				}),
			);
		}

		default: {
			const _exhaustive: never = via;
			throw new Error(
				unhandledKindMessage({
					where: "compileTerm.resolveDestinationCaseType",
					family: "RelationPath",
					received: (_exhaustive as { kind?: unknown })?.kind ?? _exhaustive,
					knownKinds: ["self", "ancestor", "subcase", "any-relation"],
				}),
			);
		}
	}
}

/**
 * Resolve the declared `data_type` for a `(caseType, property)`
 * pair from the schema map.
 *
 * `data_type` is `.optional()` on `CaseProperty` (per
 * `lib/domain/blueprint.ts:54`); when absent, the schema generator
 * treats it as `text` (per `lib/domain/predicate/jsonSchema.ts:144-148`)
 * and the term compiler does the same here so the cast mapping
 * stays consistent across both consumers.
 *
 * Missing case types and undeclared properties are type-checker-
 * bypass conditions — the body throws via `typeCheckerBypassMessage`
 * rather than falling back to a default.
 */
function lookupDataType(
	caseType: string,
	property: string,
	schemas: ReadonlyMap<string, CaseType>,
): CasePropertyDataType {
	const ct = schemas.get(caseType);
	if (ct === undefined) {
		throw new Error(
			typeCheckerBypassMessage({
				where: "compileTerm.lookupDataType",
				summary: `no schema registered for case type \`${caseType}\``,
				expected: "a `CaseType` entry in the schema map for this case type",
				received: `\`${caseType}\` is not present in the schema map`,
				hint: `register \`${caseType}\` in \`case_type_schemas\` for this app, or correct the AST to read from a declared case type.`,
			}),
		);
	}
	const propDef = ct.properties.find((p) => p.name === property);
	if (propDef === undefined) {
		throw new Error(
			typeCheckerBypassMessage({
				where: "compileTerm.lookupDataType",
				summary: `property \`${property}\` is not declared on case type \`${caseType}\``,
				expected: `\`${property}\` listed in \`case_type_schemas[appId, '${caseType}'].properties\``,
				received: `case type \`${caseType}\` declares: ${
					ct.properties.length === 0
						? "no properties"
						: ct.properties.map((p) => `\`${p.name}\``).join(", ")
				}`,
				hint: `add \`${property}\` to the case type's property list, or correct the AST to read a declared property.`,
			}),
		);
	}
	// Absent `data_type` defaults to `text`, matching the JSON
	// Schema generator's behavior at `jsonSchema.ts:144-148`.
	return propDef.data_type ?? "text";
}

// ---------------------------------------------------------------
// Runtime-binding compiler
// ---------------------------------------------------------------

/**
 * Resolve a runtime-binding term and emit a parameter-bound
 * expression.
 *
 * The three binding arms (`input`, `session-user`,
 * `session-context`) share a structural shape: a key, a binding
 * map, and a "missing key" failure mode. The shared helper
 * collapses them into one parameter-bound emission with a
 * descriptive error message; the per-arm caller passes the field
 * name into the `descriptor` so the failure cites the actual AST
 * shape the author wrote.
 *
 * Missing bindings (undefined map OR absent key) are caller-setup
 * errors — runtime values must reach the term compiler through the
 * bindings map; an absent key cannot fall back to `NULL` without
 * silently flipping the predicate's truth value.
 */
function compileBoundRef(
	key: string,
	bindings: ReadonlyMap<string, TermBindingValue> | undefined,
	descriptor: string,
): AliasableExpression<unknown> {
	if (bindings === undefined || !bindings.has(key)) {
		// Caller-setup error: the integrating pipeline omitted a
		// runtime binding the AST references. Voiced as a direct
		// "what to fix" message because the caller is the only
		// audience — these arms cannot be type-checked into existence
		// at the term layer; the binding map is the runtime-resolution
		// surface the caller owns.
		throw new Error(
			[
				`\`compileTerm\` — missing binding for ${descriptor}.`,
				``,
				`The AST references a runtime value (\`${key}\`) the wider pipeline did not`,
				`thread through \`ctx.bindings\` before calling \`compileTerm\`. Runtime-`,
				`binding terms (\`input\` / \`session-user\` / \`session-context\`) resolve from`,
				`the bindings map at compile time; an absent key cannot fall back to \`NULL\``,
				`without silently changing the predicate's truth value.`,
				``,
				`Hint: populate \`ctx.bindings.searchInputs\` / \`ctx.bindings.sessionUser\` /`,
				`\`ctx.bindings.sessionContext\` with the runtime values for every key the AST`,
				`references before calling the term compiler.`,
			].join("\n"),
		);
	}
	const value = bindings.get(key);
	// `eb.val(value)` binds the runtime value as a parameter.
	return eb.val(value);
}

// ---------------------------------------------------------------
// Type-erased typed-builder views
// ---------------------------------------------------------------
//
// Two narrow type-erased aliases exist because Kysely's typed
// builder cannot enumerate runtime-derived alias / column strings
// against `Database`'s static column set:
//
//   - `${anchorAlias}.${column}` references on the term layer
//     point at a `cases`-shaped row, but the alias is a runtime
//     value the caller threads through `TermCompileContext`.
//   - The leaf-subquery alias from `compileRelationPath` is
//     `RELATION_PATH_LEAF_ALIAS` (or its depth suffix) at runtime;
//     the typed builder cannot resolve it against `Database`'s
//     table set because the leaf is a synthesized subquery, not a
//     table key.
//
// Both views surface only the methods the call site uses; the
// underlying concrete builder still drives runtime dispatch.

/**
 * Type-erased local view of the standalone expression builder for
 * binary-op calls and column references whose first argument is a
 * runtime-derived `${alias}.${column}` string. The runtime call
 * resolves correctly because every concrete site names a
 * `cases`-shaped row at the alias position; the cast pins the
 * public `AliasableExpression<unknown>` contract.
 */
type DynamicExprBuilder = {
	(left: string, op: string, right: unknown): AliasableExpression<unknown>;
	ref: (reference: string) => AliasableExpression<unknown>;
};

/**
 * Type-erased local view of the correlated scalar subquery's
 * builder during `compileNonSelfViaPropertyRef`. The subquery
 * starts from the leaf `AliasedExpression`, applies a correlation
 * predicate against the outer anchor's `case_id`, projects the
 * inner read column, and limits to one row. The typed builder
 * cannot enumerate the leaf alias against `Database`'s table keys
 * (the leaf is a synthesized subquery), so the calls operate
 * through this minimal interface and the cast back to
 * `AliasableExpression<unknown>` happens at the public boundary.
 *
 * Each method returns the same `DynamicCorrelatedQuery` shape so
 * the chain composes without re-narrowing.
 */
interface DynamicCorrelatedQuery {
	whereRef: (left: string, op: string, right: string) => DynamicCorrelatedQuery;
	select: (selection: AliasedExpressionLike) => DynamicCorrelatedQuery;
	limit: (n: number) => DynamicCorrelatedQuery;
}

/**
 * Minimum surface needed by `DynamicCorrelatedQuery.select` — the
 * expression returned by `<column-read>.as("v")`. Surfaces only
 * the marker shape the typed builder's `select(...)` accepts as
 * an `AliasedExpression`.
 */
type AliasedExpressionLike = {
	readonly expression: unknown;
};
