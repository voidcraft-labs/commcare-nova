/**
 * Shared read-only audit for the case-type schema retirement backfill.
 *
 * Findings cover all lifecycle states that need action: an active schema absent
 * from the current materializable Blueprint, an inactive schema for a current
 * type.
 * Counts are operator context only: retirement never deletes retained cases or
 * parked values.
 */

import type { Kysely } from "kysely";
import type { Database } from "../../lib/case-store/postgres/connection";
import { buildCaseTypeMap } from "../../lib/case-store/store";
import type { PersistableDoc } from "../../lib/domain";
import { safePersistedSequence } from "../../lib/utils/persistedSequence";

export type CaseTypeSchemaRetirementIssue =
	| "active-without-blueprint"
	| "inactive-current-blueprint";

export interface CaseTypeSchemaRetirementFinding {
	readonly caseType: string;
	readonly isActive: boolean;
	readonly issues: readonly CaseTypeSchemaRetirementIssue[];
	readonly syncedSeq: number;
	readonly caseCount: number;
	readonly activeParkedValueCount: number;
	readonly dismissedParkedValueCount: number;
}

export async function findCaseTypeSchemaRetirementFindings(
	db: Kysely<Database>,
	appId: string,
	blueprint: PersistableDoc,
): Promise<readonly CaseTypeSchemaRetirementFinding[]> {
	// Storage also includes Nova's derived worker case. It is deliberately
	// absent from the authoring catalog, but must never be retired as an orphan.
	const currentTypes = new Set(buildCaseTypeMap(blueprint).keys());
	const schemaRows = await db
		.selectFrom("case_type_schemas")
		.select(["case_type", "is_active", "synced_seq"])
		.where("app_id", "=", appId)
		.orderBy("case_type")
		.execute();
	const relevantRows = schemaRows.filter(
		(row) => !row.is_active || !currentTypes.has(row.case_type),
	);
	const relevantNames = relevantRows.map((row) => row.case_type);
	if (relevantNames.length === 0) return [];

	const [caseCounts, parkedCounts] = await Promise.all([
		db
			.selectFrom("cases")
			.select("case_type")
			.select((eb) => eb.fn.countAll<string>().as("count"))
			.where("app_id", "=", appId)
			.where("case_type", "in", relevantNames)
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
			.where("case_type", "in", relevantNames)
			.groupBy("case_type")
			.execute(),
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

	return relevantRows.flatMap((row) => {
		const parked = parkedByType.get(row.case_type);
		const issues: CaseTypeSchemaRetirementIssue[] = [];
		if (row.is_active && !currentTypes.has(row.case_type)) {
			issues.push("active-without-blueprint");
		}
		if (!row.is_active && currentTypes.has(row.case_type)) {
			issues.push("inactive-current-blueprint");
		}

		if (issues.length === 0) return [];
		return [
			{
				caseType: row.case_type,
				isActive: row.is_active,
				issues,
				syncedSeq: safePersistedSequence(
					row.synced_seq,
					`case_type_schemas.synced_seq for ${appId}/${row.case_type}`,
				),
				caseCount: caseCountByType.get(row.case_type) ?? 0,
				activeParkedValueCount: parked?.active ?? 0,
				dismissedParkedValueCount: parked?.dismissed ?? 0,
			},
		];
	});
}
