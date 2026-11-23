import { type Kysely, type Expression as SqlExpression, sql } from "kysely";
import type { CaseType } from "@/lib/domain/blueprint";
import type { Expression } from "@/lib/domain/expression";
import { walkExpressionNodes } from "@/lib/domain/expression/walk";
import {
	type CaseSearchCriterion,
	type CaseSearchRequest,
	CaseSearchUnavailableError,
} from "../searchRequest";
import {
	compileExpression,
	compilePredicate,
	expressionContextFor,
	type PredicateCompileContext,
} from "../sql";
import {
	compileRelationPath,
	relationPathContextFrom,
} from "../sql/compileRelationPath";
import type { Database } from "../sql/database";
import {
	missingNativeProperty,
	nativeRangeTruth,
	nativeSearchTruth,
} from "./nativeSearchMatching";

/** Conditions using the native term dictionary are resolved together with
 * the other request filters. An uncertain candidate cannot enter the WHERE
 * clause as false and be lost before its membership has been decided. */
export function indexedSearchCondition(
	expression: Expression | undefined,
	types: ReadonlyMap<string, CaseType> | undefined,
): CaseSearchCriterion | undefined {
	if (!expression) return;
	let reason:
		| Extract<CaseSearchCriterion, { kind: "search-condition" }>["reason"]
		| undefined;
	walkExpressionNodes(expression, (node) => {
		if (node.kind === "match" && node.mode === "fuzzy") {
			reason ??= {
				kind: "fuzzy-expansion-unavailable",
				field:
					node.property.kind === "prop"
						? node.property.property
						: "Search condition",
			};
		}
		if (
			node.kind !== "gt" &&
			node.kind !== "gte" &&
			node.kind !== "lt" &&
			node.kind !== "lte"
		)
			return;
		if (node.left.kind !== "term" || node.left.term.kind !== "prop") return;
		const prop = node.left.term;
		const declared = (
			prop.caseType ? types?.get(prop.caseType) : undefined
		)?.properties.find((p) => p.name === prop.property);
		if (
			declared &&
			(declared.data_type === "time" ||
				(declared.data_type ?? "text") === "text")
		)
			reason ??= { kind: "indexed-value-unavailable", field: prop.property };
	});
	return reason ? { kind: "search-condition", expression, reason } : undefined;
}

/** Candidate truth is deliberately three-valued. SQL AND excludes a failed
 * independent condition even when another condition on that row is unknown. */
function criterionTruth(
	criterion: CaseSearchCriterion,
	ctx: PredicateCompileContext,
) {
	if (criterion.kind === "search-condition") {
		const certain = compilePredicate(criterion.expression, {
			...ctx,
			searchBound: "certain",
		});
		const possible = compilePredicate(criterion.expression, {
			...ctx,
			searchBound: "possible",
		});
		return sql<
			boolean | null
		>`case when ${certain} then true when coalesce(${possible}, false) then null else false end`;
	}
	if (criterion.kind === "missing-property") {
		// Multiple blanks on an ancestor or index take HQ's ordinary
		// missing-key branch under the original, unmodified key.
		return missingNativeProperty(criterion.key);
	}
	if (criterion.kind === "unavailable")
		return sql<boolean | null>`null::boolean`;
	if (criterion.kind === "native-range")
		return nativeRangeTruth(criterion, ctx);
	if (criterion.kind === "native") return nativeSearchTruth(criterion, ctx);
	if (criterion.kind === "fuzzy") {
		const certain = criterion.definiteMatch
			? compilePredicate(criterion.definiteMatch, ctx)
			: sql`false`;
		const excluded = criterion.definiteMiss
			? compilePredicate(criterion.definiteMiss, ctx)
			: sql`false`;
		return sql<
			boolean | null
		>`case when ${certain} then true when ${excluded} then false else null end`;
	}

	const accepted = (source: string) => {
		const column = (name: string) => sql.ref(`${source}.${name}`);
		const live = sql`select edge.ancestor_id from case_indices as edge
			join cases as target on target.case_id = edge.ancestor_id and target.app_id = ${column("app_id")} and target.project_id = ${column("project_id")}
			where edge.case_id = ${column("case_id")} and edge.depth = 1 and edge.identifier = ${criterion.identifier}`;
		const nonblank = criterion.values.filter((value) => value !== "");
		const hasTarget = sql<boolean>`exists(select 1 from (${live}) as link where link.ancestor_id = any(${nonblank}::text[]))`;
		if (criterion.blankPropertyKey !== undefined)
			return sql<boolean>`(${hasTarget} or coalesce(${column("properties")} ->> ${criterion.blankPropertyKey}, '') = '')`;
		if (criterion.blankInMultiple !== undefined)
			return sql<boolean>`(${hasTarget} or ${compilePredicate(criterion.blankInMultiple, ctx)})`;
		if (!criterion.values.includes("")) return hasTarget;
		return sql<boolean | null>`case when exists (${live}) then ${hasTarget}
			when ${criterion.identifier} = any(${column("cleared_index_identifiers")}) then true
			when ${column("index_history_complete")} then false else null end`;
	};
	const [first, ...rest] = criterion.ancestors ?? [];
	if (!first) return accepted(ctx.anchorAlias);
	const prefix = compileRelationPath(
		{
			kind: "ancestor",
			via: [
				{ identifier: first },
				...rest.map((identifier) => ({ identifier })),
			],
		},
		relationPathContextFrom(ctx),
	);
	if (prefix.kind !== "joined")
		throw new Error("A reverse-index path requires an ancestor.");
	return sql<
		boolean | null
	>`(select case when bool_or(matched) then true when bool_or(matched is null) then null else false end
		from (select ${accepted(prefix.leafAlias)} as matched from ${prefix.buildLeafSubquery()}
		where ${sql.ref(prefix.leafAlias + ".anchor_case_id")} = ${sql.ref(ctx.anchorAlias + ".case_id")}) as sources)`;
}

/** Select the bounded, certified primary set. The caller's candidate relation
 * already enforces open status, type, Project, app, holds and request
 * conditions. Only the returned IDs reach the detail query. The two share
 * one repeatable snapshot; no Preview client supplies or retains these IDs. */
export async function searchPopulationIds(
	db: Kysely<Database>,
	candidates: SqlExpression<unknown>,
	ctx: PredicateCompileContext,
	request: CaseSearchRequest,
): Promise<readonly string[]> {
	const limit = request.maximum ?? 500;
	const criteria = request.criteria ?? [];
	const order = request.order ?? [];
	const alias = (index: number) => sql.ref(`match_${index}`);
	const key = (index: number) => sql.ref(`key_${index}`);
	const projections = criteria.map(
		(criterion, index) =>
			sql`, ${criterionTruth(criterion, ctx)} as ${alias(index)}`,
	);
	const exprCtx = expressionContextFor(ctx);
	for (const [index, sort] of order.entries()) {
		const value = compileExpression(sort.expression, exprCtx);
		const ordered =
			sort.type === "text" ? sql`(${value})::text collate "C"` : value;
		projections.push(sql`, ${ordered} as ${key(index)}`);
	}
	const sortOrder =
		order.length === 0
			? sql`(select null)`
			: sql.join(
					order.map(
						(o, i) =>
							sql`${key(i)} ${o.direction === "asc" ? sql`asc nulls first` : sql`desc nulls last`}`,
					),
				);
	const possible =
		criteria.length === 0
			? sql`true`
			: sql.join(
					criteria.map((_, i) => sql`${alias(i)} is distinct from false`),
					sql` and `,
				);
	const uncertain =
		criteria.length === 0
			? sql`null::integer`
			: sql`case ${sql.join(
					criteria.map(
						(_, i) => sql`when ${alias(i)} is null then ${i}::integer`,
					),
					sql` `,
				)} else null end`;
	const result = await sql<{
		ids: string[];
		unknown_criterion: number | null;
		cutoff_tie: boolean;
		order_tie: boolean;
		exceeds_base: boolean;
	}>`with candidates as (
		select c.case_id ${sql.join(projections, sql` `)} from (${candidates}) as c
	), possible as materialized (
		select candidates.*, ${uncertain} as unknown_criterion from candidates where ${possible}
	), ranked as (
		select case_id, rank() over (order by ${sortOrder}) as hit_rank
		from possible where unknown_criterion is null
		order by ${sortOrder} limit ${limit + 1}
	), boundary as (
		select hit_rank, row_number() over (order by hit_rank, case_id collate "C") as position, case_id from ranked
	)
	select array(select case_id from boundary where position <= ${limit} order by position) as ids,
		(select min(unknown_criterion) from possible) as unknown_criterion,
		exists(select 1 from boundary where position > ${limit}) as exceeds_base,
		exists(select 1 from boundary where position = ${limit + 1} and hit_rank <= ${limit}) as cutoff_tie,
		exists(select 1 from boundary where position <= ${limit} and hit_rank < position) as order_tie`.execute(
		db,
	);
	const row = result.rows[0];
	if (row === undefined)
		throw new Error("Search membership did not return its verdict.");
	if (row.unknown_criterion !== null) {
		const criterion = criteria[row.unknown_criterion];
		if (criterion === undefined)
			throw new Error("Search membership named a missing criterion.");
		if (criterion.kind === "missing-property")
			throw new Error("An exact missing-key criterion yielded unknown.");
		if (
			criterion.kind === "unavailable" ||
			criterion.kind === "search-condition"
		)
			throw new CaseSearchUnavailableError(criterion.reason);
		if (criterion.kind === "native-range")
			throw new CaseSearchUnavailableError({
				kind: "search-range-unavailable",
				field: criterion.field,
			});
		if (criterion.kind === "native") {
			const { field, target } = criterion.parameter;
			throw new CaseSearchUnavailableError(
				target.kind === "project-space"
					? { kind: "project-space-unavailable", field }
					: { kind: "fuzzy-expansion-unavailable", field },
			);
		}
		throw new CaseSearchUnavailableError(
			criterion.kind === "index"
				? {
						kind: "link-history-unavailable",
						field: criterion.field,
						identifier: criterion.identifier,
					}
				: { kind: "fuzzy-expansion-unavailable", field: criterion.field },
		);
	}
	if (request.maximum === null && row.exceeds_base)
		throw new CaseSearchUnavailableError({ kind: "result-limit-unavailable" });
	if (request.readsHitScore && row.ids.length > 0)
		throw new CaseSearchUnavailableError({ kind: "hit-score-unavailable" });
	if (row.cutoff_tie)
		throw new CaseSearchUnavailableError({ kind: "cutoff-order-unavailable" });
	if (request.readsHitOrder && row.order_tie)
		throw new CaseSearchUnavailableError({ kind: "hit-order-unavailable" });
	return row.ids;
}
