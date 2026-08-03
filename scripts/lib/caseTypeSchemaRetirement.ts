/**
 * Shared read-only audit for the case-type schema retirement backfill.
 *
 * A candidate is an ACTIVE materialized schema whose case type is absent from
 * the app's current materializable Blueprint catalog. Counts are operator
 * context only: retirement never deletes retained cases or parked values.
 */

import { type Kysely, sql } from "kysely";
import type { Database } from "../../lib/case-store/postgres/connection";
import { indexScopeTag } from "../../lib/case-store/postgres/indexIdentity";
import type { PersistableDoc } from "../../lib/domain";
import { materializableCaseTypes } from "../../lib/domain";
import { safePersistedSequence } from "../../lib/utils/persistedSequence";

export interface CaseTypeSchemaRetirementCandidate {
	readonly caseType: string;
	readonly syncedSeq: number;
	readonly pendingIndexSeq: number | null;
	readonly caseCount: number;
	readonly activeParkedValueCount: number;
	readonly dismissedParkedValueCount: number;
	readonly expressionIndexCount: number;
}

export async function findCaseTypeSchemaRetirementCandidates(
	db: Kysely<Database>,
	appId: string,
	blueprint: PersistableDoc,
): Promise<readonly CaseTypeSchemaRetirementCandidate[]> {
	const currentTypes = new Set(
		materializableCaseTypes(blueprint).map((caseType) => caseType.name),
	);
	const activeRows = await db
		.selectFrom("case_type_schemas")
		.select(["case_type", "synced_seq", "index_pending_seq"])
		.where("app_id", "=", appId)
		.where("is_active", "=", true)
		.orderBy("case_type")
		.execute();
	const retiredNames = activeRows
		.map((row) => row.case_type)
		.filter((caseType) => !currentTypes.has(caseType));
	if (retiredNames.length === 0) return [];

	const [caseCounts, parkedCounts, indexRows] = await Promise.all([
		db
			.selectFrom("cases")
			.select("case_type")
			.select((eb) => eb.fn.countAll<string>().as("count"))
			.where("app_id", "=", appId)
			.where("case_type", "in", retiredNames)
			.groupBy("case_type")
			.execute(),
		db
			.selectFrom("parked_case_values")
			.select("case_type")
			.select((eb) => [
				eb.fn
					.count<string>("id")
					.filterWhere("dismissed_at", "is", null)
					.as("active_count"),
				eb.fn
					.count<string>("id")
					.filterWhere("dismissed_at", "is not", null)
					.as("dismissed_count"),
			])
			.where("app_id", "=", appId)
			.where("case_type", "in", retiredNames)
			.groupBy("case_type")
			.execute(),
		sql<{ index_name: string }>`
			SELECT index_relation.relname AS index_name
			FROM pg_index AS index_row
			JOIN pg_class AS index_relation
			  ON index_relation.oid = index_row.indexrelid
			WHERE index_row.indrelid = to_regclass('public.cases')
		`.execute(db),
	]);
	const caseCountByType = new Map(
		caseCounts.map((row) => [row.case_type, Number(row.count)]),
	);
	const parkedByType = new Map(
		parkedCounts.map((row) => [
			row.case_type,
			{
				active: Number(row.active_count),
				dismissed: Number(row.dismissed_count),
			},
		]),
	);

	return activeRows.flatMap((row) => {
		if (currentTypes.has(row.case_type)) return [];
		const prefix = `cases_${indexScopeTag(appId, row.case_type)}_`;
		const parked = parkedByType.get(row.case_type);
		return [
			{
				caseType: row.case_type,
				syncedSeq: safePersistedSequence(
					row.synced_seq,
					`case_type_schemas.synced_seq for ${appId}/${row.case_type}`,
				),
				pendingIndexSeq:
					row.index_pending_seq === null
						? null
						: safePersistedSequence(
								row.index_pending_seq,
								`case_type_schemas.index_pending_seq for ${appId}/${row.case_type}`,
							),
				caseCount: caseCountByType.get(row.case_type) ?? 0,
				activeParkedValueCount: parked?.active ?? 0,
				dismissedParkedValueCount: parked?.dismissed ?? 0,
				expressionIndexCount: indexRows.rows.filter((index) =>
					index.index_name.startsWith(prefix),
				).length,
			},
		];
	});
}
