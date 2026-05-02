// lib/case-store/sql/compileRelationPath.ts
//
// Compile a `RelationPath` AST node to a Kysely subquery that
// resolves to the leaf cases the path reaches. Term and Expression
// compilers thread the result into wider queries via `innerJoin`,
// reading properties off the leaf row through the subquery's
// exposed `properties` column.
//
// ## Why the AST has four kinds of relation path
//
// `RelationPath` (`lib/domain/predicate/types.ts:291-321`) is a
// four-arm discriminated union — `self`, `ancestor`, `subcase`,
// `any-relation`. The four arms encode the direction of the walk
// across the case-relation graph; the on-device emitter at
// `lib/commcare/predicate/termEmitter.ts:218-247` lowers the same
// AST node to the equivalent XPath nodeset, and this module is the
// Postgres counterpart.
//
// On the Postgres target the four arms compile to:
//
//   - `self`   — no traversal; the caller reads properties off
//                the anchor `cases` row directly.
//   - `ancestor` — one or more hops, each composed as a chain of
//                  `case_indices` + `cases` joins. The first hop's
//                  join key is the anchor's `case_id`; each
//                  subsequent hop's key is the previous hop's
//                  `ancestor_id`. The leaf is the final hop's
//                  `cases` row.
//   - `subcase`  — single hop in the reverse direction. The anchor
//                  is `case_indices.ancestor_id`; the leaf is
//                  `case_indices.case_id`.
//   - `any-relation` — `unionAll` of the ancestor and subcase
//                      single-hop forms against the same
//                      identifier, so `(ancestor | subcase)` row
//                      sets combine into one leaf relation.
//
// `subcase` and `any-relation` are single-hop in the AST schema
// (lines 311-321) — only `ancestor` admits a multi-hop tuple. The
// emitter mirrors that constraint structurally.
//
// ## Subquery encapsulation
//
// The compiled result is an aliased subquery the caller
// `innerJoin`s, NOT a list of `JoinExpression` clauses to splice
// into a parent query. The subquery holds every intermediate
// `case_indices` + `cases` pair, every tenant filter, every
// depth-1 filter, and every case-type filter; the caller's
// surface is reduced to "innerJoin this subquery on
// `subquery.anchor_case_id = anchor.case_id`". A spliced-clauses
// API would force every caller to know about each intermediate
// alias (`cases_h0`, `cases_h1`, etc.) and would couple parent
// queries to the path's hop count.
//
// ## Raw `sql` template body
//
// The subquery body is built via Kysely's `sql` template tag, the
// canonical escape hatch (Kysely docs § "Raw SQL") for SQL whose
// shape depends on dynamic, per-iteration aliases. The chain
// composes one `(case_indices, cases)` pair per AST step with
// aliases `ci0` / `cs0` / `ci1` / `cs1` / ...; Kysely's typed
// builder accumulates each `innerJoin`'s alias key into the
// table-set type, which means subsequent `where(...)` and
// `select(...)` calls would have to reference columns that don't
// exist in the static `Database` type. The `sql` tag with
// `sql.ref(...)` for column references, `sql.table(...)` for
// table names, and `${value}` for parameter binding sidesteps
// the dynamic-table-set issue and produces a `RawBuilder` that
// `.as(alias)` lifts to an `AliasedRawBuilder` — the
// `AliasedExpression` shape `innerJoin` accepts as a table
// expression.
//
// Callers still see the leaf as a typed shape (the `sql` tag's
// generic parameter pins `RawBuilder<RelationPathLeafRow>`); the
// per-column reads happen through `sql.ref(...)`, the same idiom
// the surrounding case-store code uses for `properties->>'k'`
// constructs.
//
// ## Why `case_indices.depth = 1` on every step
//
// The `case_indices` schema (spec lines 274-283; mirrored in the
// `CaseIndicesTable.depth` docstring at `database.ts`) stores the
// edge depth as `1 = direct, 2 = grandparent`. The
// materialization policy gate (spec lines 540-548) admits two
// shapes: a direct-edges-only table (one row per parent edge), or
// a fully materialized transitive closure (additional rows for
// every grandparent / great-grandparent / etc.).
//
// This module composes its multi-hop walks as a chain of direct
// edges — one `case_indices` lookup per AST step, each pinned to
// `depth = 1`. The pin makes the SQL materialization-agnostic:
// the filter skips transitive rows when they exist and
// degenerates to a no-op when they don't. Either physical shape
// produces the same row set.
//
// ## Static hop count
//
// Multi-hop walks compile as a chain of joins because the hop
// count is statically known from the AST. An `ancestor` walk
// with `via.length === N` produces N chained `case_indices`
// lookups and N chained `cases` joins; `subcase` and
// `any-relation` are single-hop. The AST has no "ancestor at any
// depth" shape — the closest construct is a wider-query
// `count({ via })` expression that wraps this module's subquery
// output and counts its rows.
//
// ## Why tenant filtering lives in this module
//
// Tenant isolation (spec § "Risk #1: tenant-isolation leak via
// missing owner-id filter") commits to structural enforcement,
// not caller discipline: the `(app_id, owner_id)` filter must be
// threaded by the layer that emits the `cases`-table read, not by
// every caller.
//
// `compileRelationPath` is the authoritative emitter for every
// intermediate `cases` join in a relation walk. Pushing the
// tenant filter into the caller would mean every term / expression
// compiler walks the relation path AST a second time and emits a
// per-step filter — duplicating logic and inviting the leak that
// structural enforcement rules out. The filter applies inside
// this module's subquery, once per hop, every time.

import type {
	AliasedExpression,
	AliasedRawBuilder,
	Kysely,
	RawBuilder,
	Selectable,
} from "kysely";
import { sql } from "kysely";
import type { RelationPath, RelationStep } from "@/lib/domain/predicate/types";
import type { Database } from "./database";

/**
 * Stable alias for the leaf subquery a joined `RelationPath`
 * exposes. The leaf alias is part of the public API of
 * `CompiledRelationPath` — callers reference columns through it
 * (`<leafAlias>.properties`, `<leafAlias>.case_id`, etc.) and
 * thread it into their own join `onRef` predicates.
 *
 * Pinned to a fixed string so the SQL output is stable across
 * compilation runs; the test suite asserts the exact alias.
 */
export const RELATION_PATH_LEAF_ALIAS = "rp_leaf";

/**
 * The row shape the relation-path leaf subquery exposes. Term and
 * Expression compilers read properties through the subquery's
 * alias, so the leaf row must surface every `cases` column either
 * compiler may need plus one synthetic column for the caller's
 * join correlation.
 *
 * The shape is derived from `Selectable<Database["cases"]>` rather
 * than hand-typed: when the `cases` table evolves (a column type
 * narrows to a string-literal union, a column gains nullability,
 * etc.) the leaf row picks up the change automatically. Hand-typed
 * columns would silently diverge.
 *
 * `Selectable<...>` strips Kysely's `ColumnType` wrappers down to
 * the read-side shape, so `properties` lands as `JsonObject`
 * (the JSONB document Postgres returns) rather than the
 * `JSONColumnType<JsonObject>` insert/update wrapper.
 *
 * The synthetic `anchor_case_id` column is the join correlation
 * key. For ancestor walks it is the anchor's `case_id` (the
 * descendant case the walk starts from); for subcase walks it is
 * the leaf's ancestor (the parent case the walk started from).
 * Callers join on `<leafAlias>.anchor_case_id =
 * <anchorAlias>.case_id`.
 */
export interface RelationPathLeafRow extends Selectable<Database["cases"]> {
	anchor_case_id: string;
}

/**
 * The compile context every `RelationPath` compilation needs:
 * the Kysely instance to build queries against, the tenant scope
 * to thread into every joined `cases` row, and the alias of the
 * outer `cases` table the caller will join the subquery onto.
 */
export interface RelationPathCompileContext {
	/**
	 * The Kysely Database handle. The compiled subquery builds
	 * against this instance's type, and consumer compilers (term,
	 * expression) thread the same handle through their own
	 * `selectFrom(...)` calls. The handle is part of the context
	 * surface so every layer of the compiler stack reads its
	 * `Kysely<Database>` from one source rather than passing it
	 * separately alongside `RelationPathCompileContext`.
	 */
	db: Kysely<Database>;

	/**
	 * The owning app — first half of the `(app_id, owner_id)`
	 * tenant pair. Spec line 389 names this as the canonical
	 * isolation key.
	 */
	appId: string;

	/**
	 * The owning user — second half of the tenant pair. `null`
	 * is admitted because HQ-imported cases pre-assignment carry
	 * a null `owner_id`; the filter compiles to `IS NULL` rather
	 * than `= NULL` (the latter is always false in SQL).
	 */
	ownerId: string | null;

	/**
	 * The alias the caller's outer query uses for the anchor
	 * `cases` row — typically `c` so the SQL reads as
	 * `c.case_id`. The compiler doesn't read this alias to
	 * generate the subquery (the subquery is uncorrelated); the
	 * field is part of the context surface so consumers have one
	 * place to record the anchor for the test gates and for the
	 * caller-side `onRef` they write against the compiled
	 * result.
	 */
	anchorAlias: string;
}

/**
 * Compiled relation-path result. Discriminated on `kind` so
 * callers branch cleanly between the no-op self path and the
 * subquery-as-join shape every other arm produces.
 *
 * The `self` arm is special — there's no relation walk, so there
 * is no leaf subquery to join. Callers handling a `self` path
 * read properties off the anchor `cases` row directly and
 * shouldn't synthesize a redundant identity join.
 */
export type CompiledRelationPath =
	| {
			/**
			 * The no-traversal degenerate. The anchor IS the leaf;
			 * callers read `<anchorAlias>.<column>` directly.
			 */
			kind: "self";
	  }
	| {
			/**
			 * The standard joined-subquery shape. The caller
			 * threads `buildLeafSubquery()` into an `innerJoin`
			 * with `onRef("<leafAlias>.anchor_case_id", "=",
			 * "<anchorAlias>.case_id")`.
			 */
			kind: "joined";

			/**
			 * The alias the leaf subquery is exposed under. Stable
			 * across compilation runs — see
			 * `RELATION_PATH_LEAF_ALIAS`. Typed as the literal
			 * `typeof RELATION_PATH_LEAF_ALIAS` rather than the
			 * widened `string` so callers can pass
			 * `` `${compiled.leafAlias}.anchor_case_id` `` to Kysely's
			 * `onRef` and retain the literal-string shape Kysely's
			 * `ReferenceExpression` requires.
			 */
			leafAlias: typeof RELATION_PATH_LEAF_ALIAS;

			/**
			 * Build the leaf subquery as an `AliasedExpression`.
			 * The result threads directly into a Kysely
			 * `innerJoin` callback: the join target is the aliased
			 * subquery, and the join condition correlates
			 * `<leafAlias>.anchor_case_id` against the caller's
			 * outer anchor `case_id` via `onRef`.
			 *
			 * The function shape (rather than a pre-built
			 * expression) lets callers decide where in their
			 * query the subquery is placed and lets the compiled
			 * result stay reusable across multiple sites in a
			 * single compilation.
			 */
			buildLeafSubquery: () => AliasedExpression<
				RelationPathLeafRow,
				typeof RELATION_PATH_LEAF_ALIAS
			>;
	  };

/**
 * Compile a `RelationPath` AST node to a join-ready
 * `CompiledRelationPath`.
 *
 * Path-kind dispatch:
 *
 *   - `self`         — returns `{ kind: "self" }`. No subquery.
 *                      Callers read columns directly off the
 *                      anchor `cases` row.
 *   - `ancestor`     — chains one `case_indices` + one `cases`
 *                      join per step in `via`. The first step's
 *                      `case_indices.case_id` correlates against
 *                      the anchor; each subsequent step's
 *                      `case_indices.case_id` correlates against
 *                      the previous step's `cases.case_id`. The
 *                      leaf is the final hop's `cases` row.
 *   - `subcase`      — single-hop reverse-direction join. The
 *                      anchor's `case_id` correlates against
 *                      `case_indices.ancestor_id`; the leaf is
 *                      the matched `case_indices.case_id`'s
 *                      `cases` row.
 *   - `any-relation` — `unionAll` of the ancestor and subcase
 *                      single-hop variants against the same
 *                      identifier. Combines both directions into
 *                      one leaf relation.
 *
 * Every joined `cases` row applies the
 * `(app_id, owner_id)` tenant filter. Every joined
 * `case_indices` row applies `depth = 1` so the SQL is
 * materialization-agnostic (works under spec § "case_indices
 * materialization policy" Option A or Option B alike).
 *
 * `RelationStep.throughCaseType` (on ancestor steps) and
 * `ofCaseType` (on subcase / any-relation) narrow the joined
 * `cases.case_type` column at the corresponding hop.
 */
export function compileRelationPath(
	path: RelationPath,
	ctx: RelationPathCompileContext,
): CompiledRelationPath {
	switch (path.kind) {
		case "self":
			return { kind: "self" };
		case "ancestor":
			return {
				kind: "joined",
				leafAlias: RELATION_PATH_LEAF_ALIAS,
				buildLeafSubquery: () =>
					aliasLeafSubquery(buildAncestorBody(ctx, path.via)),
			};
		case "subcase":
			return {
				kind: "joined",
				leafAlias: RELATION_PATH_LEAF_ALIAS,
				buildLeafSubquery: () =>
					aliasLeafSubquery(
						buildSubcaseBody(ctx, path.identifier, path.ofCaseType),
					),
			};
		case "any-relation":
			return {
				kind: "joined",
				leafAlias: RELATION_PATH_LEAF_ALIAS,
				buildLeafSubquery: () =>
					aliasLeafSubquery(
						buildAnyRelationBody(ctx, path.identifier, path.ofCaseType),
					),
			};
		default: {
			const _exhaustive: never = path;
			throw new Error(
				`compileRelationPath: unhandled RelationPath kind ${String(_exhaustive)}`,
			);
		}
	}
}

// ---------------------------------------------------------------
// Subquery body builders
// ---------------------------------------------------------------
//
// Each builder returns a `RawBuilder<RelationPathLeafRow>` for
// the body of the leaf subquery — the raw SQL between the
// outermost `(...)` parentheses, without the trailing `AS
// <alias>`. `aliasLeafSubquery` wraps the result with `.as(...)`
// to produce the final `AliasedExpression` callers consume.
//
// Splitting body construction from aliasing keeps `unionAll` for
// `any-relation` ergonomic: the union operator combines two
// bodies without each branch carrying its own alias.

/**
 * Wrap a subquery body in the documented leaf alias. Centralises
 * the alias decision so every join arm's wrapper agrees on the
 * exact identifier the caller references.
 */
function aliasLeafSubquery(
	body: RawBuilder<RelationPathLeafRow>,
): AliasedRawBuilder<RelationPathLeafRow, typeof RELATION_PATH_LEAF_ALIAS> {
	return body.as(RELATION_PATH_LEAF_ALIAS);
}

/**
 * Ancestor walk body. One hop:
 *
 *   SELECT
 *     ci0.case_id    AS anchor_case_id,
 *     cs0.case_id, cs0.app_id, ..., cs0.properties
 *   FROM case_indices AS ci0
 *   INNER JOIN cases AS cs0
 *     ON cs0.case_id = ci0.ancestor_id
 *   WHERE ci0.identifier = $1
 *     AND ci0.depth = 1
 *     AND cs0.app_id = $2
 *     AND cs0.owner_id = $3
 *     [AND cs0.case_type = $4]    -- if throughCaseType present
 *
 * N hops chain by adding one `(case_indices ci<i>, cases cs<i>)`
 * pair per step. Each step's `ci<i>.case_id` correlates against
 * the previous step's `cs<i-1>.case_id`; the final step's
 * `cs<N-1>.*` is the leaf.
 */
function buildAncestorBody(
	ctx: RelationPathCompileContext,
	via: ReadonlyArray<RelationStep>,
): RawBuilder<RelationPathLeafRow> {
	// First hop's `case_indices` is correlated by the wider join
	// (the caller's `onRef` will reference `anchor_case_id` ==
	// the outer anchor's `case_id`); the inner subquery anchors
	// the chain by exposing `ci0.case_id` as the synthetic
	// `anchor_case_id` column.
	const firstStep = via[0];
	const firstCi = "ci0";
	const firstCs = "cs0";

	// Per-hop fragments accumulate as: the cross-join chain that
	// runs FROM (`ci0` and `cs0`) plus an INNER JOIN per
	// subsequent hop, and the WHERE-clause fragments for each
	// hop's structural filters.
	const joinFragments: RawBuilder<unknown>[] = [];
	const whereFragments: RawBuilder<unknown>[] = [];

	// First hop: `FROM case_indices ci0 INNER JOIN cases cs0 ON
	// cs0.case_id = ci0.ancestor_id`. Subsequent hops chain
	// through `INNER JOIN case_indices ciN ON ciN.case_id =
	// csN-1.case_id INNER JOIN cases csN ON csN.case_id =
	// ciN.ancestor_id`.
	const fromFragment = sql`from ${sql.table("case_indices")} as ${sql.ref(firstCi)} inner join ${sql.table("cases")} as ${sql.ref(firstCs)} on ${sql.ref(`${firstCs}.case_id`)} = ${sql.ref(`${firstCi}.ancestor_id`)}`;
	whereFragments.push(
		sql`${sql.ref(`${firstCi}.identifier`)} = ${firstStep.identifier}`,
	);
	whereFragments.push(sql`${sql.ref(`${firstCi}.depth`)} = ${1}`);
	whereFragments.push(...tenantFilterFragments(firstCs, ctx));
	if (firstStep.throughCaseType !== undefined) {
		whereFragments.push(
			sql`${sql.ref(`${firstCs}.case_type`)} = ${firstStep.throughCaseType}`,
		);
	}

	let prevCs = firstCs;
	for (let i = 1; i < via.length; i++) {
		const step = via[i];
		const ci = `ci${i}`;
		const cs = `cs${i}`;
		joinFragments.push(
			sql`inner join ${sql.table("case_indices")} as ${sql.ref(ci)} on ${sql.ref(`${ci}.case_id`)} = ${sql.ref(`${prevCs}.case_id`)}`,
		);
		joinFragments.push(
			sql`inner join ${sql.table("cases")} as ${sql.ref(cs)} on ${sql.ref(`${cs}.case_id`)} = ${sql.ref(`${ci}.ancestor_id`)}`,
		);
		whereFragments.push(
			sql`${sql.ref(`${ci}.identifier`)} = ${step.identifier}`,
		);
		whereFragments.push(sql`${sql.ref(`${ci}.depth`)} = ${1}`);
		whereFragments.push(...tenantFilterFragments(cs, ctx));
		if (step.throughCaseType !== undefined) {
			whereFragments.push(
				sql`${sql.ref(`${cs}.case_type`)} = ${step.throughCaseType}`,
			);
		}
		prevCs = cs;
	}

	const leafCases = prevCs;
	const selectFragment = leafSelectFragment(firstCi, leafCases, "case_id");
	return composeSubqueryBody(
		selectFragment,
		fromFragment,
		joinFragments,
		whereFragments,
	);
}

/**
 * Subcase walk body. Single hop, reverse direction:
 *
 *   SELECT
 *     ci.ancestor_id AS anchor_case_id,
 *     cs.case_id, cs.app_id, ..., cs.properties
 *   FROM case_indices AS ci
 *   INNER JOIN cases AS cs
 *     ON cs.case_id = ci.case_id
 *   WHERE ci.identifier = $1
 *     AND ci.depth = 1
 *     AND cs.app_id = $2
 *     AND cs.owner_id = $3
 *     [AND cs.case_type = $4]    -- if ofCaseType present
 *
 * The reverse direction: an ancestor walk reads the case the
 * anchor's own index points at; a subcase walk reads the cases
 * whose own index points at the anchor.
 */
function buildSubcaseBody(
	ctx: RelationPathCompileContext,
	identifier: string,
	ofCaseType: string | undefined,
): RawBuilder<RelationPathLeafRow> {
	const ci = "ci0";
	const cs = "cs0";
	const fromFragment = sql`from ${sql.table("case_indices")} as ${sql.ref(ci)} inner join ${sql.table("cases")} as ${sql.ref(cs)} on ${sql.ref(`${cs}.case_id`)} = ${sql.ref(`${ci}.case_id`)}`;
	const whereFragments: RawBuilder<unknown>[] = [
		sql`${sql.ref(`${ci}.identifier`)} = ${identifier}`,
		sql`${sql.ref(`${ci}.depth`)} = ${1}`,
		...tenantFilterFragments(cs, ctx),
	];
	if (ofCaseType !== undefined) {
		whereFragments.push(sql`${sql.ref(`${cs}.case_type`)} = ${ofCaseType}`);
	}
	const selectFragment = leafSelectFragment(ci, cs, "ancestor_id");
	return composeSubqueryBody(selectFragment, fromFragment, [], whereFragments);
}

/**
 * Any-relation walk body: `unionAll` of the ancestor and subcase
 * single-hop variants. The two branches expose the same
 * `RelationPathLeafRow` shape; the union combines the row sets
 * without de-duplicating.
 *
 * `UNION ALL` rather than `UNION`: the AST never expresses
 * "either direction but only once," and the wider query's
 * downstream filters (the `where` predicate a `count` / `exists`
 * expression wraps around the leaf subquery) decide whether
 * duplicates are semantically distinct.
 */
function buildAnyRelationBody(
	ctx: RelationPathCompileContext,
	identifier: string,
	ofCaseType: string | undefined,
): RawBuilder<RelationPathLeafRow> {
	const ancestorBranch = buildAncestorBody(ctx, [
		ofCaseType === undefined
			? { identifier }
			: { identifier, throughCaseType: ofCaseType },
	]);
	const subcaseBranch = buildSubcaseBody(ctx, identifier, ofCaseType);
	// Paren-wrap the union as a whole so `.as("rp_leaf")` aliases the
	// combined relation, not just the second branch's tail. The two
	// branches are already paren-wrapped by `composeSubqueryBody`,
	// so the resulting SQL is `((SELECT ...) UNION ALL (SELECT ...))`
	// — nested parens, valid Postgres. Without the outer wrap the
	// alias attaches to the subcase branch and the union itself
	// becomes the JOIN target, which is a parse error.
	return sql<RelationPathLeafRow>`(${ancestorBranch} union all ${subcaseBranch})`;
}

// ---------------------------------------------------------------
// Shared SQL fragments
// ---------------------------------------------------------------

/**
 * Build the tenant-filter fragments for a `cases`-table alias.
 * Returns one fragment for `app_id` and one for `owner_id` —
 * either `= $val` or `is null` depending on `ctx.ownerId`.
 *
 * Threading these fragments through every `cases` join is the
 * structural anchor for spec Risk #1's tenant-isolation
 * guarantee.
 *
 * `ownerId` of `null` compiles to `IS NULL` rather than `=
 * NULL`. SQL's three-valued logic makes `<col> = NULL` always
 * unknown (and therefore false in a `WHERE` context), so the
 * `IS NULL` form is required for the HQ-imported pre-assignment
 * fixture rows the spec lists at lines 127-130.
 */
function tenantFilterFragments(
	casesAlias: string,
	ctx: RelationPathCompileContext,
): RawBuilder<unknown>[] {
	const fragments: RawBuilder<unknown>[] = [
		sql`${sql.ref(`${casesAlias}.app_id`)} = ${ctx.appId}`,
	];
	if (ctx.ownerId === null) {
		fragments.push(sql`${sql.ref(`${casesAlias}.owner_id`)} is null`);
	} else {
		fragments.push(sql`${sql.ref(`${casesAlias}.owner_id`)} = ${ctx.ownerId}`);
	}
	return fragments;
}

/**
 * Build the `SELECT` fragment for a leaf subquery. The
 * `anchor_case_id` synthetic column is sourced from the given
 * `case_indices` alias's `case_id` (ancestor walks) or
 * `ancestor_id` (subcase walks); the rest of the projection
 * mirrors the `RelationPathLeafRow` shape sourced from the leaf
 * `cases` alias.
 */
function leafSelectFragment(
	caseIndicesAlias: string,
	leafAlias: string,
	anchorColumn: "case_id" | "ancestor_id",
): RawBuilder<unknown> {
	return sql`select
		${sql.ref(`${caseIndicesAlias}.${anchorColumn}`)} as ${sql.ref("anchor_case_id")},
		${sql.ref(`${leafAlias}.case_id`)} as ${sql.ref("case_id")},
		${sql.ref(`${leafAlias}.app_id`)} as ${sql.ref("app_id")},
		${sql.ref(`${leafAlias}.case_type`)} as ${sql.ref("case_type")},
		${sql.ref(`${leafAlias}.owner_id`)} as ${sql.ref("owner_id")},
		${sql.ref(`${leafAlias}.status`)} as ${sql.ref("status")},
		${sql.ref(`${leafAlias}.opened_on`)} as ${sql.ref("opened_on")},
		${sql.ref(`${leafAlias}.modified_on`)} as ${sql.ref("modified_on")},
		${sql.ref(`${leafAlias}.closed_on`)} as ${sql.ref("closed_on")},
		${sql.ref(`${leafAlias}.parent_case_id`)} as ${sql.ref("parent_case_id")},
		${sql.ref(`${leafAlias}.properties`)} as ${sql.ref("properties")}`;
}

/**
 * Compose the SELECT, FROM-with-first-join, additional joins,
 * and WHERE fragments into one subquery body. `sql.join(...)`
 * interpolates the additional joins as space-separated SQL
 * fragments and the WHERE fragments as `AND`-separated boolean
 * expressions — the canonical Kysely pattern for stitching a
 * variable number of fragments into one expression.
 */
function composeSubqueryBody(
	selectFragment: RawBuilder<unknown>,
	fromFragment: RawBuilder<unknown>,
	additionalJoins: RawBuilder<unknown>[],
	whereFragments: RawBuilder<unknown>[],
): RawBuilder<RelationPathLeafRow> {
	const joinsSql =
		additionalJoins.length === 0
			? sql``
			: sql` ${sql.join(additionalJoins, sql` `)}`;
	const whereSql = sql` where ${sql.join(whereFragments, sql` and `)}`;
	// Paren-wrap the body so that `<body>.as("rp_leaf")` produces
	// `(SELECT ... WHERE ...) AS "rp_leaf"`, which is what Postgres
	// requires for an `INNER JOIN <subquery> AS <alias>` target.
	// `RawBuilder.as` does not insert parentheses; the responsibility
	// belongs to whoever assembles the body. Without the wrap the
	// emitted SQL is `INNER JOIN SELECT ... WHERE ... AS "rp_leaf"`,
	// which is a Postgres parse error.
	return sql<RelationPathLeafRow>`(${selectFragment} ${fromFragment}${joinsSql}${whereSql})`;
}
