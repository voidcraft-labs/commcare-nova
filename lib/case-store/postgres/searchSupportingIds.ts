import { type Kysely, sql, type Transaction } from "kysely";
import type { CaseSearchRequest } from "../searchRequest";
import { searchRelatedLiveScope } from "../sql/compileRestoreScope";
import type { Database } from "../sql/database";

/** HQ expands a dynamic ID property first, then traverses the combined
 * source records. Only the terminals are returned. A supporting case can
 * be closed and can have another case type. The source and target of each
 * step must belong to this app and Project in the same read snapshot. */
export async function searchSupportingIds(
	tx: Transaction<Database>,
	tenant: { appId: string; projectId: string },
	primary: readonly string[],
	request?: CaseSearchRequest,
): Promise<string[]> {
	if (!primary.length || !request) return [];
	const {
		relatedRecordProperty,
		relatedPaths = [],
		relatedChildTypes = [],
		includeRelatedHierarchy,
	} = request;
	if (
		!relatedRecordProperty &&
		!relatedPaths.length &&
		!relatedChildTypes.length &&
		!includeRelatedHierarchy
	)
		return [];
	const { appId, projectId } = tenant;
	const visibleRecords = (db: Kysely<Database>) =>
		db
			.selectFrom("cases as target")
			.select("target.case_id")
			.where("target.app_id", "=", appId)
			.where("target.project_id", "=", projectId)
			.where(({ not, exists, selectFrom }) =>
				not(
					exists(
						selectFrom("parked_case_values as held")
							.select("held.id")
							.whereRef("held.case_id", "=", "target.case_id")
							.where("held.dismissed_at", "is", null),
					),
				),
			);
	const records = visibleRecords(tx);
	const related = new Set<string>();
	if (relatedRecordProperty) {
		const referenced = tx
			.selectFrom("cases as source")
			.select(
				sql<string>`source.properties ->> ${relatedRecordProperty}`.as(
					"related_id",
				),
			)
			.where("source.app_id", "=", appId)
			.where("source.project_id", "=", projectId)
			.where(sql<boolean>`source.case_id = any(${primary}::text[])`);
		for (const row of await records
			.where("target.case_id", "in", referenced)
			.execute()) {
			related.add(row.case_id);
		}
	}
	const sources = [...new Set([...primary, ...related])];
	if (includeRelatedHierarchy) {
		const scope = searchRelatedLiveScope(tx, tenant, sources);
		for (const row of await visibleRecords(scope.creator)
			.where(scope.holds("target"))
			.execute())
			related.add(row.case_id);
	} else {
		const prefixes = new Map<string, string[]>();
		for (const path of relatedPaths) {
			let ids = sources;
			for (let depth = 0; depth < path.length && ids.length; depth++) {
				const key = JSON.stringify(path.slice(0, depth + 1));
				const cached = prefixes.get(key);
				if (cached) {
					ids = cached;
					continue;
				}
				const found = await records
					.innerJoin(
						"case_indices as edge",
						"edge.ancestor_id",
						"target.case_id",
					)
					.where("edge.depth", "=", 1)
					.where("edge.identifier", "=", path[depth])
					.where(sql<boolean>`edge.case_id = any(${ids}::text[])`)
					.distinct()
					.execute();
				ids = found.map((row) => row.case_id);
				prefixes.set(key, ids);
			}
			for (const id of ids) related.add(id);
		}
	}
	if (includeRelatedHierarchy || relatedChildTypes.length) {
		let children = records
			.innerJoin("case_indices as edge", "edge.case_id", "target.case_id")
			.where("edge.depth", "=", 1)
			.where("edge.identifier", "=", "parent")
			.where(sql<boolean>`edge.ancestor_id = any(${sources}::text[])`);
		if (!includeRelatedHierarchy)
			children = children.where("target.case_type", "in", relatedChildTypes);
		for (const row of await children.distinct().execute())
			related.add(row.case_id);
	}
	for (const id of primary) related.delete(id);
	return [...related];
}
