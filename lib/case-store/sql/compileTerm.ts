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
//     `date`, `time`, `datetime`, `single_select`, `geopoint`) and
//     applies a Postgres cast (`::int`, `::numeric`, `::date`, etc.)
//     to lift the text value into the typed comparison world.
//     Verified at the Postgres docs reference at
//     `https://www.postgresql.org/docs/16/functions-json.html` —
//     "JSON Object Field as Text" returns `text`.
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
// emits a correlated scalar subquery: `(SELECT
// (<leaf>.properties ->> 'name')::cast FROM <leaf-aliased-expr>
// WHERE <leaf>.anchor_case_id = <ctx.anchorAlias>.case_id LIMIT
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

import type { Kysely, RawBuilder } from "kysely";
import { sql } from "kysely";
import type { CasePropertyDataType, CaseType } from "@/lib/domain";
import type { RelationPath, Term } from "@/lib/domain/predicate/types";
import { compileRelationPath } from "./compileRelationPath";
import type { Database } from "./database";

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
// data_type → Postgres cast token
// ---------------------------------------------------------------

/**
 * The Postgres cast token a `data_type` lifts into. The values are
 * Postgres type names (without the leading `::`); the caller
 * applies the cast as `(<expr>)::<cast>` via the `sql` template tag.
 *
 * Cast choices:
 *
 *   - `text` — explicit cast on text-flavored properties (`text`,
 *     `single_select`, `geopoint`, undefined). `properties->>'X'`
 *     already returns text, but the explicit cast documents intent
 *     and stays uniform with the other arms' shape.
 *   - `int` — `data_type: "int"`. Rejects fractional decoding from
 *     a JSONB number that happens to be stored without a decimal
 *     point.
 *   - `numeric` — `data_type: "decimal"`. Postgres's arbitrary-
 *     precision decimal; matches the JSON Schema generator's
 *     `{ type: "number" }` shape.
 *   - `date` / `time` / `timestamptz` — temporal cast tokens. The
 *     JSONB read returns the wire-form ISO string; the cast lifts
 *     to the typed temporal value Postgres can compare ordinally.
 *     `timestamptz` (rather than `timestamp`) preserves timezone
 *     info from the wire string.
 *   - `jsonb` — `data_type: "multi_select"`. The predicate compiler
 *     needs JSONB on the left side of `?|` / `?&` / `@>`; reading
 *     via `->>` yields a stringified blob those operators can't
 *     process. The corresponding read operator is `->` (returns
 *     JSONB) rather than `->>` — see
 *     `JSONB_READ_OPERATOR_FOR_DATA_TYPE` below.
 */
export const POSTGRES_CAST_FOR_DATA_TYPE: Readonly<
	Record<CasePropertyDataType, string>
> = {
	text: "text",
	int: "int",
	decimal: "numeric",
	date: "date",
	time: "time",
	datetime: "timestamptz",
	single_select: "text",
	multi_select: "jsonb",
	geopoint: "text",
};

/**
 * The JSONB property-read operator used to read a property of a
 * given `data_type`. Two variants:
 *
 *   - `->>` returns text. Used for every text-flavored arm — the
 *     JSON Schema generator stores these as JSON strings, and the
 *     `::cast` lifts the text into the typed Postgres value.
 *   - `->` returns jsonb. Used for `multi_select` because the
 *     predicate compiler's `multi-select-contains` arm operates on
 *     JSONB arrays. Casting the result to `::jsonb` is structurally
 *     redundant (the operator already returns jsonb) but stays
 *     uniform with the other arms' "read + cast" shape and makes
 *     the column-type explicit at the read site.
 */
const JSONB_READ_OPERATOR_FOR_DATA_TYPE: Readonly<
	Record<CasePropertyDataType, "->" | "->>">
> = {
	text: "->>",
	int: "->>",
	decimal: "->>",
	date: "->>",
	time: "->>",
	datetime: "->>",
	single_select: "->>",
	multi_select: "->",
	geopoint: "->>",
};

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
 *   - `literal` → parameter binding via the `sql` template tag for
 *     non-null primitives, the `null` SQL keyword for the null
 *     literal, wrapped in a Postgres cast when the literal carries
 *     a `data_type`.
 *   - `input` / `session-user` / `session-context` → parameter
 *     binding from the corresponding `bindings` map; throws a
 *     clear error when the binding is missing.
 *
 * The return type is `RawBuilder<unknown>` rather than the wider
 * `Expression<unknown>` because every arm produces a value-bearing
 * SQL fragment built from the `sql` template tag, and consumers
 * (the predicate compiler / expression compiler / their caller-side
 * `as(...)` aliases) need `RawBuilder`'s `.as(alias)` and
 * `.toOperationNode()` methods that `Expression` alone doesn't
 * expose. The unknown payload is deliberate — each arm resolves to
 * a different per-Postgres-type expression but the runtime
 * dispatches by `term.kind`, and the wider compilers consume the
 * return as a generic operand.
 */
export function compileTerm(
	term: Term,
	ctx: TermCompileContext,
): RawBuilder<unknown> {
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
				`compileTerm: unhandled Term kind ${String(_exhaustive)}`,
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
 *      emits a correlated scalar subquery: `(SELECT
 *      (<leaf>.properties ->> 'name')::cast FROM <leaf-aliased-expr>
 *      WHERE <leaf>.anchor_case_id = <ctx.anchorAlias>.case_id
 *      LIMIT 1)`. The subquery applies the via's join chain inside
 *      its own SQL scope and correlates back to the outer anchor.
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
): RawBuilder<unknown> {
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
}): RawBuilder<unknown> {
	const { anchorAlias, caseType, property, schemas } = args;
	if (RESERVED_SCALAR_COLUMNS.has(property)) {
		return sql`${sql.ref(`${anchorAlias}.${property}`)}`;
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
}): RawBuilder<unknown> {
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
			"compileTerm.compilePropertyRef: unreachable — non-self relation path produced a 'self' compiled result",
		);
	}

	// Inner column-read inside the subquery body. Reserved scalars
	// read directly off the leaf alias; everything else reads the
	// JSONB `properties` column with the per-data-type cast.
	const leafAlias = compiledPath.leafAlias;
	const innerRead = RESERVED_SCALAR_COLUMNS.has(property)
		? sql`${sql.ref(`${leafAlias}.${property}`)}`
		: jsonbColumnRead({
				sourceAlias: leafAlias,
				property,
				dataType: lookupDataType(lookupCaseType, property, ctx.caseTypeSchemas),
			});

	// Correlated scalar subquery: select the read expression from
	// the aliased leaf with a correlation predicate to the outer
	// anchor's `case_id`. `LIMIT 1` makes the result scalar — the
	// term compiler's contract is "value-bearing expression";
	// without `LIMIT 1`, a multi-row leaf would surface as a
	// "more than one row returned by a subquery used as an
	// expression" runtime error.
	const leafSubquery = compiledPath.buildLeafSubquery();
	const correlation = sql`${sql.ref(`${leafAlias}.anchor_case_id`)} = ${sql.ref(`${anchorAlias}.case_id`)}`;
	return sql`(select ${innerRead} from ${leafSubquery} where ${correlation} limit 1)`;
}

/**
 * Emit a JSONB property read with the per-data-type cast and
 * read operator. Shared between self-via and non-self-via
 * dispatch — both paths read JSONB documents the same way, only
 * the source alias differs.
 *
 * `sql.raw` is safe for both `readOperator` and `cast` because
 * each value comes from a closed-enum lookup keyed on
 * `CasePropertyDataType`; no caller-supplied input flows into the
 * raw-emission slot.
 */
function jsonbColumnRead(args: {
	sourceAlias: string;
	property: string;
	dataType: CasePropertyDataType;
}): RawBuilder<unknown> {
	const { sourceAlias, property, dataType } = args;
	const cast = POSTGRES_CAST_FOR_DATA_TYPE[dataType];
	const readOperator = JSONB_READ_OPERATOR_FOR_DATA_TYPE[dataType];
	return sql`(${sql.ref(`${sourceAlias}.properties`)} ${sql.raw(readOperator)} ${property})::${sql.raw(cast)}`;
}

/**
 * Resolve the destination case-type name a `RelationPath` reaches.
 *
 * The four AST kinds map to three resolution shapes:
 *
 *   - `self` — the path doesn't change scope. Callers branch off
 *     this kind before invoking the helper; the runtime body throws
 *     to surface any future caller routing `self` here through an
 *     untyped boundary.
 *   - `ancestor` — walk the `parent_type` chain, one hop per
 *     `RelationStep`. Each hop's destination is the previous origin's
 *     `parent_type`; the first hop's origin is `originCaseType`.
 *   - `subcase` / `any-relation` — find the case type whose
 *     `parent_type` is `originCaseType`. `ofCaseType` selects when
 *     present; with no qualifier and exactly one candidate the
 *     unique candidate wins.
 *
 * Mirrors `checkRelationPath` in
 * `lib/domain/predicate/typeChecker.ts:1080-1232`. The type checker
 * accumulates errors for user-facing reporting; the SQL compiler
 * throws because a resolution failure here is a bug at the type-
 * checker layer (the type checker validates every term against the
 * same schema before the SQL compiler runs).
 */
function resolveDestinationCaseType(
	via: RelationPath,
	originCaseType: string,
	schemas: ReadonlyMap<string, CaseType>,
): string {
	switch (via.kind) {
		case "self":
			throw new Error(
				"compileTerm.resolveDestinationCaseType: 'self' is unreachable here — callers route 'self' through the originating-scope branch before invoking this helper.",
			);

		case "ancestor": {
			let current = originCaseType;
			for (let i = 0; i < via.via.length; i++) {
				const step = via.via[i];
				const ct = schemas.get(current);
				if (ct === undefined) {
					throw new Error(
						`compileTerm: unknown case type '${current}' at ancestor hop ${i} — the type checker should have caught this before reaching the SQL compiler`,
					);
				}
				if (!ct.parent_type) {
					throw new Error(
						`compileTerm: ancestor walk failed: case type '${current}' has no parent_type — the type checker should have caught this before reaching the SQL compiler`,
					);
				}
				if (
					step.throughCaseType !== undefined &&
					step.throughCaseType !== ct.parent_type
				) {
					throw new Error(
						`compileTerm: throughCaseType '${step.throughCaseType}' on ancestor step does not match the actual parent_type '${ct.parent_type}' of '${current}'`,
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
				`compileTerm: '${via.kind}' walk needs an explicit ofCaseType — found ${candidates.length} candidate case types (${candidates.map((c) => `'${c}'`).join(", ")}) for origin '${originCaseType}'. The type checker should have caught this before reaching the SQL compiler.`,
			);
		}

		default: {
			const _exhaustive: never = via;
			throw new Error(
				`compileTerm.resolveDestinationCaseType: unhandled RelationPath kind ${String(_exhaustive)}`,
			);
		}
	}
}

/**
 * Resolve the declared `data_type` for a `(caseType, property)`
 * pair from the schema map.
 *
 * A missing case type or a property absent from the looked-up case
 * type's schema is a bug at the type-checker layer (the type
 * checker validates every term against the same schema before the
 * SQL compiler runs), so the compiler throws rather than fall back
 * to a default.
 *
 * `data_type` is `.optional()` on `CaseProperty` (per
 * `lib/domain/blueprint.ts:54`); when absent, the schema generator
 * treats it as `text` (per `lib/domain/predicate/jsonSchema.ts:144-148`)
 * and the term compiler does the same here so the cast mapping
 * stays consistent across both consumers.
 */
function lookupDataType(
	caseType: string,
	property: string,
	schemas: ReadonlyMap<string, CaseType>,
): CasePropertyDataType {
	const ct = schemas.get(caseType);
	if (ct === undefined) {
		throw new Error(
			`compileTerm: no schema registered for case type '${caseType}' — the type checker should have caught this before reaching the SQL compiler`,
		);
	}
	const propDef = ct.properties.find((p) => p.name === property);
	if (propDef === undefined) {
		throw new Error(
			`compileTerm: property '${property}' is not declared on case type '${caseType}' — the type checker should have caught this before reaching the SQL compiler`,
		);
	}
	// Absent `data_type` defaults to `text`, matching the JSON
	// Schema generator's behavior at `jsonSchema.ts:144-148`.
	return propDef.data_type ?? "text";
}

// ---------------------------------------------------------------
// `literal` — primitive constant compiler
// ---------------------------------------------------------------

/**
 * Compile a `literal` term to a Kysely expression.
 *
 * Three concerns interact:
 *
 *   1. Value typing — the AST admits string / number / boolean /
 *      null. Each maps to a corresponding Postgres-bindable value;
 *      `null` is handled specially because SQL's `NULL` is a
 *      keyword, not a value, and binding it as a parameter inflates
 *      the parameter list without expressivity gain.
 *   2. Parameter binding — non-null primitives flow through Kysely's
 *      `${value}` substitution which binds as a parameter (`$N`
 *      placeholder). Inlining values is unsafe (no escaping) and
 *      shifts plan-cache invariants off-spec; binding is the
 *      canonical pattern.
 *   3. Optional `data_type` cast — when the literal carries an
 *      explicit `data_type` (typed temporal literals construct
 *      this shape via `dateLiteral` / `datetimeLiteral` /
 *      `timeLiteral` builders), the compiler emits `$N::cast` so
 *      the bound parameter is well-typed for comparison against a
 *      typed `prop` read. Without `data_type`, the parameter is
 *      bound bare and Postgres's implicit type coercion handles
 *      the comparison.
 */
function compileLiteral(
	term: Extract<Term, { kind: "literal" }>,
): RawBuilder<unknown> {
	const { value, data_type } = term;

	// `null` literal: emit the SQL `NULL` keyword. Kysely's `eb.lit`
	// is the canonical way to embed a literal token rather than a
	// parameter; for `null` it produces the keyword.
	if (value === null) {
		return sql`null`;
	}

	// Bind the value as a parameter. The `${value}` substitution in
	// the `sql` template tag treats it as a parameter (matching
	// Kysely's docs § "raw SQL"); `data_type` adds the cast.
	if (data_type !== undefined) {
		const cast = POSTGRES_CAST_FOR_DATA_TYPE[data_type];
		return sql`${value}::${sql.raw(cast)}`;
	}
	return sql`${value}`;
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
 * name into the message so the failure cites the actual AST shape
 * the author wrote.
 *
 * When the bindings map is undefined OR the key is absent from
 * the map, the helper throws. Runtime bindings are required-by-
 * position; the wider pipeline must thread the values through
 * before calling the term compiler. A missing binding at compile
 * time is a misuse, not a runtime null.
 */
function compileBoundRef(
	key: string,
	bindings: ReadonlyMap<string, TermBindingValue> | undefined,
	descriptor: string,
): RawBuilder<unknown> {
	if (bindings === undefined || !bindings.has(key)) {
		throw new Error(
			`compileTerm: missing binding for ${descriptor} — the wider pipeline must thread runtime values through ctx.bindings before calling compileTerm`,
		);
	}
	const value = bindings.get(key);
	// `${value}` substitution binds as a parameter.
	return sql`${value}`;
}
