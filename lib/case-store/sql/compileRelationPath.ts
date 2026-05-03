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
// ## Alias isolation: depth-suffix on the leaf, scoping on the hops
//
// Two distinct alias-collision concerns surface across nested
// relation walks, and the compiler answers them with two distinct
// mechanisms:
//
// **Hop aliases (`ci0` / `cs0` / `ci1` / ...) — handled by SQL
// subquery scoping.** Each `compileRelationPath` call's hop
// aliases are local to its own SELECT. Two nested calls produce
// two `(SELECT ... FROM case_indices ci0 INNER JOIN cases cs0
// ...) AS <leafAlias>` blocks; SQL's scoping rule isolates each
// block's `ci0` / `cs0` identifiers from the surrounding query
// and from every sibling block. A nested call's `ci0` shadows
// nothing because the outer `ci0` is not in scope inside the
// inner SELECT, and the inner one is not in scope outside it.
//
// **Leaf alias (`rp_leaf`) — handled by per-depth uniquification.**
// SQL subquery scoping does NOT isolate inner→outer references
// to a same-named alias. When an inner subquery's WHERE clause
// references the outer leaf (the predicate compiler's
// correlated-EXISTS body, or the term compiler's correlated
// scalar subquery), Postgres binds the unqualified `rp_leaf` to
// the innermost FROM list — so the inner alias shadows the outer
// one and the correlation predicate `<outer-leaf>.case_id =
// <outer-leaf>.<col>` collapses into the inner row's self-equality
// (always false for a `parent` walk by construction). The
// `RelationPathCompileContext.relationPathDepth` counter, threaded
// by consumers when they recurse into an inner `where`, drives
// `leafAliasForDepth(depth)` — `rp_leaf` at depth 0,
// `rp_leaf_<N>` at deeper nestings. The depth-suffix is the
// structural defense; without it, nested non-self walks emit
// silently-wrong correlations that pass cold-compile assertions
// but fail every harness round-trip.
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
// missing owner-id filter", lines 559-562) commits to structural
// enforcement, not caller discipline: the `(app_id, owner_id)`
// filter must be threaded by the layer that emits the
// `cases`-table read, not by every caller.
//
// `compileRelationPath` is the authoritative emitter for every
// intermediate `cases` join in a relation walk. Pushing the
// tenant filter into the caller would mean every term / expression
// compiler walks the relation path AST a second time and emits a
// per-step filter — duplicating logic and inviting the leak that
// structural enforcement rules out. The filter applies inside
// this module's subquery, once per hop, every time.

import type { AliasedExpression, Kysely, Selectable } from "kysely";
import { unhandledKindMessage } from "@/lib/domain/predicate/errors";
import type { RelationPath, RelationStep } from "@/lib/domain/predicate/types";
import type { Database } from "./database";

/**
 * Alias-name prefix for every relation-path leaf subquery the
 * compiler emits. The leaf alias the consumer joins on is this
 * prefix optionally suffixed by the relation-walk depth — depth 0
 * stays bare (`rp_leaf`) for SQL readability; deeper nestings
 * append the depth (`rp_leaf_1`, `rp_leaf_2`, ...).
 *
 * Why depth-suffixed when nested: SQL identifier resolution
 * inside a correlated EXISTS reads the innermost matching alias
 * first. An outer `exists(parent, where: exists(parent, where:
 * <inner-where>))` produces two `(SELECT 1 FROM <leaf> AS
 * rp_leaf WHERE rp_leaf.anchor_case_id = <outer>.case_id ...)`
 * blocks; if the inner block also aliases its leaf as `rp_leaf`,
 * the inner WHERE's correlation reference reads the inner alias
 * (the closest match), not the outer one — the outer correlation
 * silently breaks. The depth suffix keeps each block's alias
 * unique so the inner correlation can refer back to the outer
 * leaf by its depth-specific name.
 *
 * The bare `RELATION_PATH_LEAF_ALIAS` string is exported as the
 * canonical depth-0 name. Consumers that read leaf columns at
 * the outermost depth use this constant; consumers nesting deeper
 * read the actual alias from the compiled result's `leafAlias`
 * field, which reflects the chosen depth.
 */
export const RELATION_PATH_LEAF_ALIAS = "rp_leaf";

/**
 * Build the leaf alias for a given relation-walk depth. Depth 0
 * is the bare prefix; deeper depths append the count.
 *
 * The function is exported because consumers occasionally need to
 * compute a leaf alias up front (e.g. the predicate compiler's
 * EXISTS body builds its `<inner-leaf>.anchor_case_id =
 * <outer-leaf>.case_id` correlation from the outer context's
 * pre-recursion depth before the inner `compileRelationPath`
 * runs).
 */
export function leafAliasForDepth(depth: number): string {
	return depth === 0
		? RELATION_PATH_LEAF_ALIAS
		: `${RELATION_PATH_LEAF_ALIAS}_${depth}`;
}

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
	 * against this instance's typed query builder, and consumer
	 * compilers (term, expression) thread the same handle through
	 * their own `selectFrom(...)` calls. The handle is part of the
	 * context surface so every layer of the compiler stack reads
	 * its `Kysely<Database>` from one source rather than passing
	 * it separately alongside `RelationPathCompileContext`.
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

	/**
	 * The relation-walk nesting depth at this compile site. Zero
	 * at the outermost compile; incremented by consumers that
	 * recurse into a relation-walk leaf's inner `where` predicate
	 * (the predicate compiler's `exists`/`missing` arm; the
	 * expression compiler's `count` arm with an inner `where`).
	 * Optional, defaulting to 0 — the outermost depth.
	 *
	 * The depth selects a unique leaf alias per nesting level so
	 * an inner subquery's leaf does not shadow the outer leaf's
	 * alias inside the inner WHERE's correlation. SQL identifier
	 * resolution reads the innermost matching alias first; an
	 * unsuffixed alias collision would silently break the
	 * outer-leaf correlation.
	 */
	relationPathDepth?: number;
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
			 * The alias the leaf subquery is exposed under. The
			 * value is `RELATION_PATH_LEAF_ALIAS` (the bare prefix)
			 * at depth 0 and `${RELATION_PATH_LEAF_ALIAS}_<depth>`
			 * for deeper nesting. Typed as `string` rather than a
			 * literal because the depth is a runtime value.
			 *
			 * Callers thread the alias through their join `onRef`
			 * via `` `${compiled.leafAlias}.anchor_case_id` ``;
			 * Kysely's `ReferenceExpression` admits a string
			 * template here even though the static type widens.
			 */
			leafAlias: string;

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
			buildLeafSubquery: () => AliasedExpression<RelationPathLeafRow, string>;
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
 * `(app_id, owner_id)` tenant filter (spec § "Risk #1", lines
 * 559-562). Every joined `case_indices` row applies `depth = 1`
 * so the SQL is materialization-agnostic (works under spec §
 * "case_indices materialization policy" Option A or Option B
 * alike).
 *
 * `RelationStep.throughCaseType` (on ancestor steps) and
 * `ofCaseType` (on subcase / any-relation) narrow the joined
 * `cases.case_type` column at the corresponding hop.
 */
export function compileRelationPath(
	path: RelationPath,
	ctx: RelationPathCompileContext,
): CompiledRelationPath {
	const leafAlias = leafAliasForDepth(ctx.relationPathDepth ?? 0);
	switch (path.kind) {
		case "self":
			return { kind: "self" };
		case "ancestor":
			return {
				kind: "joined",
				leafAlias,
				buildLeafSubquery: () =>
					buildAncestorLeaf({ ctx, via: path.via, leafAlias }),
			};
		case "subcase":
			return {
				kind: "joined",
				leafAlias,
				buildLeafSubquery: () =>
					buildSubcaseLeaf({
						ctx,
						identifier: path.identifier,
						ofCaseType: path.ofCaseType,
						leafAlias,
					}),
			};
		case "any-relation":
			return {
				kind: "joined",
				leafAlias,
				buildLeafSubquery: () =>
					buildAnyRelationLeaf({
						ctx,
						identifier: path.identifier,
						ofCaseType: path.ofCaseType,
						leafAlias,
					}),
			};
		default: {
			const _exhaustive: never = path;
			throw new Error(
				unhandledKindMessage({
					where: "compileRelationPath",
					family: "RelationPath",
					received: (_exhaustive as { kind?: unknown })?.kind ?? _exhaustive,
					knownKinds: ["self", "ancestor", "subcase", "any-relation"],
				}),
			);
		}
	}
}

// ---------------------------------------------------------------
// Leaf-subquery builders
// ---------------------------------------------------------------
//
// Each builder constructs an `AliasedExpression<RelationPathLeafRow,
// "rp_leaf">` via Kysely's typed query builder. The resulting
// expression slots directly into an `innerJoin(() => ..., (jb) =>
// jb.onRef(...))` call: the consumer correlates the synthetic
// `anchor_case_id` column against its outer anchor's `case_id`.
//
// The Kysely typed builder accepts table expressions of the form
// `'cases as cs0'` and accumulates each alias into the resulting
// query's table-set type. `where(...)` and `select(...)` calls
// then reference columns by `'cs0.<column>'`-style strings, with
// Kysely's template-literal types resolving each alias back to
// the underlying table's column set.
//
// Single-hop arms (the ancestor first hop, subcase, any-relation)
// build entirely under the typed builder's static type checking.
// Multi-hop ancestor walks chain additional `case_indices` /
// `cases` pairs in a runtime loop whose alias names (`ci<i>`,
// `cs<i>`) are computed from the AST's hop counter; the loop body
// runs under a type-erased local view of the query because TS
// cannot enumerate the per-iteration alias permutations the loop
// produces. The hop count is statically bounded by the AST schema
// (an ancestor `via` is a non-empty tuple-with-rest of
// `RelationStep`), so the loop's runtime behavior is well-defined
// even where the type system loses precision.
//
// The final cast on each builder's return is `as unknown as
// AliasedExpression<RelationPathLeafRow, string>` because the
// Kysely-inferred output is a structural superset of
// `RelationPathLeafRow` (every column on `cases` plus the synthetic
// `anchor_case_id`). The cast pins the public contract; the
// projection list builders below construct the matching shape by
// construction. The second type argument is `string` rather than
// the literal `"rp_leaf"` because the depth suffix is a runtime
// value — `leafAliasForDepth(0)` returns `"rp_leaf"`, deeper
// nestings return `"rp_leaf_<N>"`, and the union over every
// possible depth widens to `string`.

/**
 * Build the ancestor-walk leaf subquery.
 *
 * Single-hop shape:
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
 * N-hop walks chain one `(case_indices, cases)` pair per step
 * after the first via additional `innerJoin`s. Each step's
 * `ci<i>.case_id` correlates against the previous step's
 * `cs<i-1>.case_id`; the final step's `cs<N-1>.*` is the leaf.
 */
function buildAncestorLeaf(args: {
	ctx: RelationPathCompileContext;
	via: ReadonlyArray<RelationStep>;
	leafAlias: string;
}): AliasedExpression<RelationPathLeafRow, string> {
	const { ctx, via, leafAlias } = args;
	const firstStep = via[0];

	// First hop under full typed-builder visibility. The literal
	// `'case_indices as ci0'` and `'cases as cs0'` table aliases
	// land in the surrounding query's `TB` template-literal type so
	// the column references that follow type-check against the
	// underlying tables.
	const firstHop = ctx.db
		.selectFrom("case_indices as ci0")
		.innerJoin("cases as cs0", "cs0.case_id", "ci0.ancestor_id")
		.where("ci0.identifier", "=", firstStep.identifier)
		.where("ci0.depth", "=", 1)
		.where("cs0.app_id", "=", ctx.appId);

	// The owner-id branch must use the `is null` keyword form for
	// the null-owner case; SQL's three-valued logic makes
	// `<col> = NULL` always evaluate to unknown (false in WHERE).
	const firstHopWithOwner =
		ctx.ownerId === null
			? firstHop.where("cs0.owner_id", "is", null)
			: firstHop.where("cs0.owner_id", "=", ctx.ownerId);

	const firstHopWithType =
		firstStep.throughCaseType !== undefined
			? firstHopWithOwner.where("cs0.case_type", "=", firstStep.throughCaseType)
			: firstHopWithOwner;

	if (via.length === 1) {
		// Single-hop walk: the leaf cases alias is `cs0`. Project
		// directly under typed inference and alias as the leaf.
		const projected = firstHopWithType.select([
			"ci0.case_id as anchor_case_id",
			"cs0.case_id as case_id",
			"cs0.app_id as app_id",
			"cs0.case_type as case_type",
			"cs0.owner_id as owner_id",
			"cs0.status as status",
			"cs0.opened_on as opened_on",
			"cs0.modified_on as modified_on",
			"cs0.closed_on as closed_on",
			"cs0.parent_case_id as parent_case_id",
			"cs0.properties as properties",
		]);
		return projected.as(leafAlias) as unknown as AliasedExpression<
			RelationPathLeafRow,
			string
		>;
	}

	// Multi-hop walk. The dynamic-iteration loop operates under a
	// type-erased local view (`DynamicQuery`) because TS cannot
	// enumerate the per-iteration alias accumulation through the
	// runtime loop. Inside the loop, alias strings are constructed
	// from the AST's hop counter — a closed-set value bounded by
	// the AST schema's tuple-with-rest shape; runtime behavior is
	// well-defined.
	let qb: DynamicQuery = firstHopWithType as unknown as DynamicQuery;
	let prevCasesAlias = "cs0";
	let leafCasesAlias = "cs0";
	for (let i = 1; i < via.length; i++) {
		const step = via[i];
		const ci = `ci${i}`;
		const cs = `cs${i}`;
		qb = qb
			.innerJoin(
				`case_indices as ${ci}`,
				`${ci}.case_id`,
				`${prevCasesAlias}.case_id`,
			)
			.innerJoin(`cases as ${cs}`, `${cs}.case_id`, `${ci}.ancestor_id`)
			.where(`${ci}.identifier`, "=", step.identifier)
			.where(`${ci}.depth`, "=", 1)
			.where(`${cs}.app_id`, "=", ctx.appId);
		qb =
			ctx.ownerId === null
				? qb.where(`${cs}.owner_id`, "is", null)
				: qb.where(`${cs}.owner_id`, "=", ctx.ownerId);
		if (step.throughCaseType !== undefined) {
			qb = qb.where(`${cs}.case_type`, "=", step.throughCaseType);
		}
		prevCasesAlias = cs;
		leafCasesAlias = cs;
	}

	// Project the leaf row. The select-list strings are computed
	// from `leafCasesAlias` (the final hop's `cs<N-1>` alias); the
	// runtime list shape always produces every column on
	// `RelationPathLeafRow`.
	const projected = qb.select([
		`ci0.case_id as anchor_case_id`,
		`${leafCasesAlias}.case_id as case_id`,
		`${leafCasesAlias}.app_id as app_id`,
		`${leafCasesAlias}.case_type as case_type`,
		`${leafCasesAlias}.owner_id as owner_id`,
		`${leafCasesAlias}.status as status`,
		`${leafCasesAlias}.opened_on as opened_on`,
		`${leafCasesAlias}.modified_on as modified_on`,
		`${leafCasesAlias}.closed_on as closed_on`,
		`${leafCasesAlias}.parent_case_id as parent_case_id`,
		`${leafCasesAlias}.properties as properties`,
	]);
	return projected.as(leafAlias) as unknown as AliasedExpression<
		RelationPathLeafRow,
		string
	>;
}

/**
 * Build the subcase-walk leaf subquery. Single hop, reverse
 * direction:
 *
 *   SELECT
 *     ci0.ancestor_id AS anchor_case_id,
 *     cs0.case_id, cs0.app_id, ..., cs0.properties
 *   FROM case_indices AS ci0
 *   INNER JOIN cases AS cs0
 *     ON cs0.case_id = ci0.case_id
 *   WHERE ci0.identifier = $1
 *     AND ci0.depth = 1
 *     AND cs0.app_id = $2
 *     AND cs0.owner_id = $3
 *     [AND cs0.case_type = $4]    -- if ofCaseType present
 *
 * The reverse direction: an ancestor walk reads the case the
 * anchor's own index points at; a subcase walk reads the cases
 * whose own index points at the anchor.
 */
function buildSubcaseLeaf(args: {
	ctx: RelationPathCompileContext;
	identifier: string;
	ofCaseType: string | undefined;
	leafAlias: string;
}): AliasedExpression<RelationPathLeafRow, string> {
	const { ctx, identifier, ofCaseType, leafAlias } = args;

	const base = ctx.db
		.selectFrom("case_indices as ci0")
		.innerJoin("cases as cs0", "cs0.case_id", "ci0.case_id")
		.where("ci0.identifier", "=", identifier)
		.where("ci0.depth", "=", 1)
		.where("cs0.app_id", "=", ctx.appId);

	const withOwner =
		ctx.ownerId === null
			? base.where("cs0.owner_id", "is", null)
			: base.where("cs0.owner_id", "=", ctx.ownerId);

	const withType =
		ofCaseType !== undefined
			? withOwner.where("cs0.case_type", "=", ofCaseType)
			: withOwner;

	const projected = withType.select([
		"ci0.ancestor_id as anchor_case_id",
		"cs0.case_id as case_id",
		"cs0.app_id as app_id",
		"cs0.case_type as case_type",
		"cs0.owner_id as owner_id",
		"cs0.status as status",
		"cs0.opened_on as opened_on",
		"cs0.modified_on as modified_on",
		"cs0.closed_on as closed_on",
		"cs0.parent_case_id as parent_case_id",
		"cs0.properties as properties",
	]);

	return projected.as(leafAlias) as unknown as AliasedExpression<
		RelationPathLeafRow,
		string
	>;
}

/**
 * Build the any-relation leaf subquery: a `UNION ALL` of the
 * ancestor and subcase single-hop variants against the same
 * identifier. The two branches expose the same
 * `RelationPathLeafRow` shape; the union combines the row sets
 * without de-duplicating.
 *
 * `UNION ALL` rather than `UNION`: the AST never expresses
 * "either direction but only once," and the wider query's
 * downstream filters (the `where` predicate a `count` / `exists`
 * expression wraps around the leaf subquery) decide whether
 * duplicates are semantically distinct.
 *
 * Both branches are constructed via the same typed-builder shape
 * the single-direction builders use, then unioned together via
 * Kysely's `unionAll(...)` operator. The aliasing happens once on
 * the combined query so the consumer's `innerJoin` target is the
 * full union, not just the trailing branch.
 */
function buildAnyRelationLeaf(args: {
	ctx: RelationPathCompileContext;
	identifier: string;
	ofCaseType: string | undefined;
	leafAlias: string;
}): AliasedExpression<RelationPathLeafRow, string> {
	const { ctx, identifier, ofCaseType, leafAlias } = args;

	// Ancestor branch: identical shape to a single-hop ancestor
	// walk against the identifier. `ofCaseType` here is the same
	// pin as `throughCaseType` on a single-hop ancestor — both
	// narrow the joined `cases.case_type` column at the leaf hop.
	const ancestorBase = ctx.db
		.selectFrom("case_indices as ci0")
		.innerJoin("cases as cs0", "cs0.case_id", "ci0.ancestor_id")
		.where("ci0.identifier", "=", identifier)
		.where("ci0.depth", "=", 1)
		.where("cs0.app_id", "=", ctx.appId);
	const ancestorWithOwner =
		ctx.ownerId === null
			? ancestorBase.where("cs0.owner_id", "is", null)
			: ancestorBase.where("cs0.owner_id", "=", ctx.ownerId);
	const ancestorWithType =
		ofCaseType !== undefined
			? ancestorWithOwner.where("cs0.case_type", "=", ofCaseType)
			: ancestorWithOwner;
	const ancestorBranch = ancestorWithType.select([
		"ci0.case_id as anchor_case_id",
		"cs0.case_id as case_id",
		"cs0.app_id as app_id",
		"cs0.case_type as case_type",
		"cs0.owner_id as owner_id",
		"cs0.status as status",
		"cs0.opened_on as opened_on",
		"cs0.modified_on as modified_on",
		"cs0.closed_on as closed_on",
		"cs0.parent_case_id as parent_case_id",
		"cs0.properties as properties",
	]);

	// Subcase branch: the reverse direction. Both branches must
	// project the same column names in the same order so
	// `unionAll` accepts them as compatible.
	const subcaseBase = ctx.db
		.selectFrom("case_indices as ci0")
		.innerJoin("cases as cs0", "cs0.case_id", "ci0.case_id")
		.where("ci0.identifier", "=", identifier)
		.where("ci0.depth", "=", 1)
		.where("cs0.app_id", "=", ctx.appId);
	const subcaseWithOwner =
		ctx.ownerId === null
			? subcaseBase.where("cs0.owner_id", "is", null)
			: subcaseBase.where("cs0.owner_id", "=", ctx.ownerId);
	const subcaseWithType =
		ofCaseType !== undefined
			? subcaseWithOwner.where("cs0.case_type", "=", ofCaseType)
			: subcaseWithOwner;
	const subcaseBranch = subcaseWithType.select([
		"ci0.ancestor_id as anchor_case_id",
		"cs0.case_id as case_id",
		"cs0.app_id as app_id",
		"cs0.case_type as case_type",
		"cs0.owner_id as owner_id",
		"cs0.status as status",
		"cs0.opened_on as opened_on",
		"cs0.modified_on as modified_on",
		"cs0.closed_on as closed_on",
		"cs0.parent_case_id as parent_case_id",
		"cs0.properties as properties",
	]);

	// `unionAll(rhs)` accepts another select query of compatible
	// output shape and emits `(<lhs>) UNION ALL (<rhs>)` in
	// Postgres. The combined query's output type is the LHS
	// branch's type — both branches share the identical
	// projection here, so the union output stays well-typed.
	return ancestorBranch
		.unionAll(subcaseBranch)
		.as(leafAlias) as unknown as AliasedExpression<RelationPathLeafRow, string>;
}

// ---------------------------------------------------------------
// Type-erased multi-hop loop helpers
// ---------------------------------------------------------------

/**
 * Type-erased local view of the multi-hop ancestor query during
 * the per-iteration `innerJoin` chain. The TS template-literal
 * type system cannot enumerate the per-iteration alias
 * accumulation a runtime loop produces, so the loop body operates
 * under this minimal interface and the final `.select(...)` /
 * `.as(...)` chain casts back to the public `AliasedExpression`
 * contract.
 *
 * The interface surfaces only the methods the loop calls — `where`,
 * `innerJoin`, and `select`. Each returns the same `DynamicQuery`
 * shape so the loop body chains without re-narrowing. The runtime
 * methods these stand in for are Kysely's typed `where` / `innerJoin`
 * / `select`; they produce well-formed SQL regardless of static
 * inference because the alias strings the loop constructs match
 * the runtime tables.
 *
 * The argument type is `unknown` (not `never`) so the loop body
 * can pass the runtime-constructed alias strings; the runtime
 * dispatch lives inside Kysely's typed methods which the underlying
 * concrete builder still drives.
 */
interface DynamicQuery {
	where: (...args: ReadonlyArray<unknown>) => DynamicQuery;
	innerJoin: (...args: ReadonlyArray<unknown>) => DynamicQuery;
	select: (selections: ReadonlyArray<string>) => DynamicSelection;
}

/**
 * Type-erased local view of the projected select for the multi-hop
 * loop's final step. Surfaces only `.as(...)` because that's the
 * one method the loop's tail calls; the cast back to
 * `AliasedExpression<RelationPathLeafRow, string>` happens at the
 * public boundary. The second type argument is `string` rather
 * than the literal `"rp_leaf"` because the depth suffix is a
 * runtime value — see the alias-isolation header section above.
 */
interface DynamicSelection {
	as: (alias: string) => AliasedExpression<unknown, string>;
}
