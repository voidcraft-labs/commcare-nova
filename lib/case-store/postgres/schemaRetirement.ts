/** Dependency-light transactional case-type retirement. */

import { sql, type Transaction } from "kysely";
import { caseTypeToJsonSchema } from "@/lib/domain/expression/jsonSchema";
import { safePersistedSequence } from "@/lib/utils/persistedSequence";
import type { Database, JsonObject } from "../sql/database";
import type { ApplyCaseTypeSchemaRetirementArgs } from "../store";
import { caseSchemaIndexLockScope } from "./indexIdentity";

/**
 * Mark schemas inactive on the caller's app-locked transaction. Retained case
 * and parked-value rows are deliberately untouched.
 */
export async function retireCaseTypeSchemasInTransaction(
	tx: Transaction<Database>,
	args: ApplyCaseTypeSchemaRetirementArgs,
): Promise<readonly string[]> {
	const desiredSeq = safePersistedSequence(
		args.desiredSeq,
		`case-type schema retirement sequence for app ${args.appId}`,
	);
	const caseTypes = [...new Set(args.caseTypes)].sort();
	if (caseTypes.length === 0) return [];

	const fallbackSchemas = new Map<string, JsonObject>();
	for (const caseType of caseTypes) {
		const declaration = args.fallbackCaseTypeSchemas.get(caseType);
		if (declaration !== undefined) {
			fallbackSchemas.set(caseType, caseTypeToJsonSchema(declaration));
		}
	}

	// Match every multi-type schema operation: all advisory locks first in
	// lexical order, then all lifecycle rows in lexical order.
	for (const caseType of caseTypes) {
		await sql`
			SELECT pg_advisory_xact_lock(
				hashtextextended(${caseSchemaIndexLockScope(args.appId, caseType)}, 0)
			)
		`.execute(tx);
	}
	const existingRows = await tx
		.selectFrom("case_type_schemas")
		.select(["case_type", "schema", "synced_seq", "is_active"])
		.where("app_id", "=", args.appId)
		.where("case_type", "in", caseTypes)
		.orderBy("case_type")
		.forUpdate()
		.execute();
	const existingByType = new Map(
		existingRows.map((row) => [row.case_type, row]),
	);

	const retired: string[] = [];
	for (const caseType of caseTypes) {
		const existing = existingByType.get(caseType);
		if (
			existing !== undefined &&
			desiredSeq <
				safePersistedSequence(
					existing.synced_seq,
					`stored case_type_schemas.synced_seq for ${args.appId}/${caseType}`,
				)
		) {
			continue;
		}
		const archivedSchema = existing?.schema ?? fallbackSchemas.get(caseType);
		if (archivedSchema === undefined) {
			throw new Error(
				`Case-type retirement has neither a stored nor fallback schema for ${caseType}.`,
			);
		}
		const upserted = await tx
			.insertInto("case_type_schemas")
			.values({
				app_id: args.appId,
				case_type: caseType,
				schema: JSON.stringify(archivedSchema),
				synced_seq: desiredSeq,
				retired_seq: desiredSeq,
			})
			.onConflict((conflict) =>
				conflict
					.columns(["app_id", "case_type"])
					.doUpdateSet((eb) => ({
						synced_seq: eb.ref("excluded.synced_seq"),
						retired_seq: eb.ref("excluded.retired_seq"),
					}))
					.where(
						sql<boolean>`excluded.synced_seq >= case_type_schemas.synced_seq`,
					),
			)
			.returning("case_type")
			.executeTakeFirst();
		if (upserted === undefined) continue;
		retired.push(caseType);
	}
	return retired;
}
