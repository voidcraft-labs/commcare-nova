import {
	type DeleteQueryBuilder,
	type DeleteResult,
	sql,
	type Transaction,
} from "kysely";
import type { CaseIndicesTable, Database } from "../sql/database";

interface CaseScope {
	appId: string;
	projectId: string;
}

/** Remember only the direct links the same transaction actually removed.
 * A repeated clear of an absent link cannot establish whether it once
 * existed. The marker lives and dies on its source case, in its Project. */
export async function clearCaseIndices(
	tx: Transaction<Database>,
	scope: CaseScope,
	deletion: DeleteQueryBuilder<Database, "case_indices", DeleteResult>,
) {
	const removed = deletion.returning(["case_id", "identifier", "depth"]);
	await sql`WITH removed AS (${removed}),
		clears AS (
			SELECT case_id, array_agg(identifier) AS names
			FROM removed WHERE depth = 1 GROUP BY case_id
		)
		UPDATE cases AS c SET cleared_index_identifiers = ARRAY(
			SELECT DISTINCT name COLLATE "C" FROM unnest(c.cleared_index_identifiers || clears.names) names(name)
			ORDER BY 1
		)
		FROM clears WHERE c.case_id = clears.case_id AND c.app_id = ${scope.appId}
			AND c.project_id = ${scope.projectId}`.execute(tx);
}

/** Called with the app's relationship write lock and the source case
 * authorized for mutation. Live and cleared are mutually exclusive. */
export async function replaceCaseIndex(
	tx: Transaction<Database>,
	scope: CaseScope,
	caseId: string,
	identifier: string,
	target: {
		id: string;
		caseType: string;
		relationship: CaseIndicesTable["relationship"];
	} | null,
) {
	const deletion = tx
		.deleteFrom("case_indices")
		.where("case_id", "=", caseId)
		.where("identifier", "=", identifier)
		.where(
			"case_id",
			"in",
			tx
				.selectFrom("cases")
				.select("case_id")
				.where("case_id", "=", caseId)
				.where("project_id", "=", scope.projectId)
				.where("app_id", "=", scope.appId),
		);
	if (target === null) {
		await clearCaseIndices(tx, scope, deletion);
		return;
	}
	await deletion.execute();
	await tx
		.insertInto("case_indices")
		.values({
			case_id: caseId,
			identifier,
			ancestor_id: target.id,
			target_case_type: target.caseType,
			relationship: target.relationship,
			depth: 1,
		})
		.execute();
	await tx
		.updateTable("cases")
		.set({
			cleared_index_identifiers: sql<
				string[]
			>`array_remove(cleared_index_identifiers, ${identifier}::text)`,
		})
		.where("app_id", "=", scope.appId)
		.where("project_id", "=", scope.projectId)
		.where("case_id", "=", caseId)
		.where(sql<boolean>`${identifier} = ANY(cleared_index_identifiers)`)
		.execute();
}
