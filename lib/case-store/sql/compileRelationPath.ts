// lib/case-store/sql/compileRelationPath.ts
//
// Compile a `RelationPath` to an aliased Kysely subquery.
// `RelationPath` (`lib/domain/predicate/types.ts::RelationPath`)
// has four arms — `self`, `ancestor`, `subcase`, `any-relation`:
//
// - `self` — no traversal; callers read off the anchor directly.
// - `ancestor` — chain of `case_indices` + `cases` joins, one per
//   `RelationStep`. Multi-hop only.
// - `subcase` — single-hop reverse direction.
// - `any-relation` — `UNION ALL` of single-hop ancestor + subcase
//   against the same identifier.
//
// The compiled result is an aliased subquery the caller
// `innerJoin`s — not a list of `JoinExpression` clauses to splice.
// The subquery holds every intermediate alias / tenant filter /
// `depth = 1` filter / case-type filter; callers see a single
// "innerJoin this on `<leaf>.anchor_case_id = anchor.case_id`"
// surface and never know the hop count.
//
// ## Alias isolation: depth-suffix on the leaf, scoping on hops
//
// Hop aliases (`ci0` / `cs0` / ...) are isolated by SQL subquery
// scoping — each call's hops live inside their own SELECT. The
// leaf alias is NOT isolated for inner→outer references: when an
// inner subquery's WHERE references the outer leaf (correlated
// EXISTS body, correlated scalar subquery), Postgres binds the
// unqualified `rp_leaf` to the innermost FROM list, so the inner
// alias would shadow the outer one and the correlation collapses
// into the inner row's self-equality. `relationPathDepth` drives
// `leafAliasForDepth(depth)` — `rp_leaf` at depth 0,
// `rp_leaf_<N>` at deeper nestings — to defend against the
// shadow. Without the suffix, nested non-self walks emit
// silently-wrong correlations that pass cold-compile assertions
// but fail every harness round-trip.
//
// ## `case_indices.depth = 1` on every step
//
// The `case_indices` schema admits direct-edges-only OR fully-
// materialized transitive closures. Pinning `depth = 1` per hop
// makes the SQL materialization-agnostic: the filter skips
// transitive rows when they exist and is a no-op when they don't.
//
// ## Tenant filtering lives in this module
//
// `(app_id, project_id)` must be threaded by the layer emitting the
// `cases` read, not the caller. Pushing the filter to callers
// would duplicate the relation-walk traversal and invite a leak.
// The filter applies once per hop, every time.

import type { AliasedExpression, Kysely, Selectable } from "kysely";
import { unhandledKindMessage } from "@/lib/domain/predicate/errors";
import type { RelationPath, RelationStep } from "@/lib/domain/predicate/types";
import type { Database } from "./database";

/**
 * Canonical depth-0 leaf alias. Deeper nestings get
 * `rp_leaf_<depth>` via `leafAliasForDepth` — see the file header
 * for the alias-isolation rationale. Consumers reading at the
 * outermost depth use this constant; consumers nesting deeper
 * read the actual alias from `compiled.leafAlias`.
 */
export const RELATION_PATH_LEAF_ALIAS = "rp_leaf";

/**
 * Build the leaf alias for a relation-walk depth. Exported because
 * consumers occasionally compute the alias up front (the predicate
 * compiler's EXISTS body builds its correlation from the outer
 * context's pre-recursion depth before the inner
 * `compileRelationPath` runs).
 */
export function leafAliasForDepth(depth: number): string {
	return depth === 0
		? RELATION_PATH_LEAF_ALIAS
		: `${RELATION_PATH_LEAF_ALIAS}_${depth}`;
}

/**
 * Row shape the leaf subquery exposes — every `cases` column plus
 * the synthetic `anchor_case_id`. Derived from
 * `Selectable<Database["cases"]>` so a `cases` schema change
 * propagates automatically; hand-typed columns would silently
 * diverge.
 *
 * `anchor_case_id` is the join correlation key — the anchor's
 * `case_id` for ancestor walks, the parent's for subcase walks.
 */
export interface RelationPathLeafRow extends Selectable<Database["cases"]> {
	anchor_case_id: string;
}

/** Compile context. */
export interface RelationPathCompileContext {
	db: Kysely<Database>;
	/** First half of `(app_id, project_id)`. */
	appId: string;
	/**
	 * Second half — the bound Project (tenant). Non-null: every
	 * relation-walk hop filters joined `cases` rows on
	 * `project_id = <bound>`. (`owner_id`, the CommCare case-owner, is a
	 * separate axis and is NOT a relation-walk tenant filter.)
	 */
	projectId: string;
	/**
	 * Outer query's alias for the anchor `cases` row. Recorded for
	 * caller-side `onRef`; the subquery itself is uncorrelated.
	 */
	anchorAlias: string;
	/** Relation-walk nesting depth — see file header for the alias-isolation rationale. */
	relationPathDepth?: number;
}

/**
 * Compiled result. `self` is the no-traversal degenerate (callers
 * read off the anchor directly, no identity join). `joined` is the
 * subquery-as-join shape every other arm produces — callers thread
 * `buildLeafSubquery()` into an `innerJoin` with
 * `onRef("<leafAlias>.anchor_case_id", "=", "<anchorAlias>.case_id")`.
 *
 * `buildLeafSubquery` is a function (not a pre-built expression)
 * so callers can place the subquery anywhere in the outer query
 * and reuse one compiled result across multiple sites.
 */
export type CompiledRelationPath =
	| { kind: "self" }
	| {
			kind: "joined";
			leafAlias: string;
			buildLeafSubquery: () => AliasedExpression<RelationPathLeafRow, string>;
	  };

/**
 * Compile a `RelationPath` to a join-ready `CompiledRelationPath`.
 * `RelationStep.throughCaseType` (ancestor) and `ofCaseType`
 * (subcase / any-relation) narrow the joined `cases.case_type` at
 * the corresponding hop.
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

// Leaf-subquery builders. Each constructs the
// `AliasedExpression<RelationPathLeafRow, string>` shape consumers
// `innerJoin`. Single-hop arms build entirely under the typed
// builder; multi-hop ancestor walks chain pairs in a runtime loop
// under `DynamicQuery` because TS can't enumerate per-iteration
// alias permutations. The final cast pins the public contract;
// the projection-list builders construct the matching shape by
// construction.

/**
 * Ancestor-walk leaf subquery. Single-hop shape:
 *
 * ```
 * SELECT ci0.case_id AS anchor_case_id, cs0.case_id, ..., cs0.properties
 * FROM case_indices AS ci0
 * INNER JOIN cases AS cs0 ON cs0.case_id = ci0.ancestor_id
 * WHERE ci0.identifier = $1 AND ci0.depth = 1
 *   AND cs0.app_id = $2 AND cs0.project_id = $3
 *   [AND cs0.case_type = $4]
 * ```
 *
 * N-hop walks chain `(case_indices, cases)` pairs; each step's
 * `ci<i>.case_id` correlates against the previous step's
 * `cs<i-1>.case_id`.
 */
function buildAncestorLeaf(args: {
	ctx: RelationPathCompileContext;
	via: ReadonlyArray<RelationStep>;
	leafAlias: string;
}): AliasedExpression<RelationPathLeafRow, string> {
	const { ctx, via, leafAlias } = args;
	const firstStep = via[0];

	const firstHop = ctx.db
		.selectFrom("case_indices as ci0")
		.innerJoin("cases as cs0", "cs0.case_id", "ci0.ancestor_id")
		.where("ci0.identifier", "=", firstStep.identifier)
		.where("ci0.depth", "=", 1)
		.where("cs0.app_id", "=", ctx.appId);

	const firstHopWithProject = firstHop.where(
		"cs0.project_id",
		"=",
		ctx.projectId,
	);

	const firstHopWithType =
		firstStep.throughCaseType !== undefined
			? firstHopWithProject.where(
					"cs0.case_type",
					"=",
					firstStep.throughCaseType,
				)
			: firstHopWithProject;

	if (via.length === 1) {
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
			"cs0.case_name as case_name",
			"cs0.parent_case_id as parent_case_id",
			"cs0.properties as properties",
		]);
		return projected.as(leafAlias) as unknown as AliasedExpression<
			RelationPathLeafRow,
			string
		>;
	}

	// Multi-hop loop under `DynamicQuery`. Alias strings derive
	// from the AST's hop counter (bounded by the tuple-with-rest
	// schema), so the runtime is well-defined.
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
		qb = qb.where(`${cs}.project_id`, "=", ctx.projectId);
		if (step.throughCaseType !== undefined) {
			qb = qb.where(`${cs}.case_type`, "=", step.throughCaseType);
		}
		prevCasesAlias = cs;
		leafCasesAlias = cs;
	}

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
		`${leafCasesAlias}.case_name as case_name`,
		`${leafCasesAlias}.parent_case_id as parent_case_id`,
		`${leafCasesAlias}.properties as properties`,
	]);
	return projected.as(leafAlias) as unknown as AliasedExpression<
		RelationPathLeafRow,
		string
	>;
}

/**
 * Subcase leaf — single hop, reverse direction. An ancestor walk
 * reads the case the anchor's index points at; a subcase walk
 * reads the cases whose own index points at the anchor.
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

	const withProject = base.where("cs0.project_id", "=", ctx.projectId);

	const withType =
		ofCaseType !== undefined
			? withProject.where("cs0.case_type", "=", ofCaseType)
			: withProject;

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
		"cs0.case_name as case_name",
		"cs0.parent_case_id as parent_case_id",
		"cs0.properties as properties",
	]);

	return projected.as(leafAlias) as unknown as AliasedExpression<
		RelationPathLeafRow,
		string
	>;
}

/**
 * Any-relation: `UNION ALL` of single-hop ancestor + subcase. The
 * AST never expresses "either direction but only once", and
 * downstream filters in the wrapping `count` / `exists` decide
 * whether duplicates are semantically distinct.
 */
function buildAnyRelationLeaf(args: {
	ctx: RelationPathCompileContext;
	identifier: string;
	ofCaseType: string | undefined;
	leafAlias: string;
}): AliasedExpression<RelationPathLeafRow, string> {
	const { ctx, identifier, ofCaseType, leafAlias } = args;

	// `ofCaseType` here narrows the same way `throughCaseType` does
	// on a single-hop ancestor.
	const ancestorBase = ctx.db
		.selectFrom("case_indices as ci0")
		.innerJoin("cases as cs0", "cs0.case_id", "ci0.ancestor_id")
		.where("ci0.identifier", "=", identifier)
		.where("ci0.depth", "=", 1)
		.where("cs0.app_id", "=", ctx.appId);
	const ancestorWithProject = ancestorBase.where(
		"cs0.project_id",
		"=",
		ctx.projectId,
	);
	const ancestorWithType =
		ofCaseType !== undefined
			? ancestorWithProject.where("cs0.case_type", "=", ofCaseType)
			: ancestorWithProject;
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
		"cs0.case_name as case_name",
		"cs0.parent_case_id as parent_case_id",
		"cs0.properties as properties",
	]);

	// Both branches must project the same column names in the same
	// order for `unionAll` to accept them.
	const subcaseBase = ctx.db
		.selectFrom("case_indices as ci0")
		.innerJoin("cases as cs0", "cs0.case_id", "ci0.case_id")
		.where("ci0.identifier", "=", identifier)
		.where("ci0.depth", "=", 1)
		.where("cs0.app_id", "=", ctx.appId);
	const subcaseWithProject = subcaseBase.where(
		"cs0.project_id",
		"=",
		ctx.projectId,
	);
	const subcaseWithType =
		ofCaseType !== undefined
			? subcaseWithProject.where("cs0.case_type", "=", ofCaseType)
			: subcaseWithProject;
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
		"cs0.case_name as case_name",
		"cs0.parent_case_id as parent_case_id",
		"cs0.properties as properties",
	]);

	return ancestorBranch
		.unionAll(subcaseBranch)
		.as(leafAlias) as unknown as AliasedExpression<RelationPathLeafRow, string>;
}

// Type-erased multi-hop loop helpers. The TS template-literal
// type system can't enumerate the per-iteration alias
// accumulation a runtime loop produces, so the loop body runs
// under these minimal interfaces and the final
// `.select(...).as(...)` chain casts back at the public boundary.

interface DynamicQuery {
	where: (...args: ReadonlyArray<unknown>) => DynamicQuery;
	innerJoin: (...args: ReadonlyArray<unknown>) => DynamicQuery;
	select: (selections: ReadonlyArray<string>) => DynamicSelection;
}

interface DynamicSelection {
	as: (alias: string) => AliasedExpression<unknown, string>;
}
