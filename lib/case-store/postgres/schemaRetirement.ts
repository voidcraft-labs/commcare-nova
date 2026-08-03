/** Dependency-light transactional retirement and maintenance index drain. */

import { type Kysely, sql, type Transaction } from "kysely";
import { caseTypeToJsonSchema } from "@/lib/domain/predicate/jsonSchema";
import { safePersistedSequence } from "@/lib/utils/persistedSequence";
import type { Database, JsonObject } from "../sql/database";
import type { ApplyCaseTypeSchemaRetirementArgs } from "../store";
import { caseSchemaIndexLockScope, indexScopeTag } from "./indexIdentity";

/**
 * Mark schemas inactive on the caller's app-locked transaction. Retained case
 * and parked-value rows are deliberately untouched.
 */
export async function retireCaseTypeSchemasPhaseA(
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
				index_pending_seq: desiredSeq,
			})
			.onConflict((conflict) =>
				conflict
					.columns(["app_id", "case_type"])
					.doUpdateSet((eb) => ({
						synced_seq: eb.ref("excluded.synced_seq"),
						retired_seq: eb.ref("excluded.retired_seq"),
						index_pending_seq: eb.ref("excluded.index_pending_seq"),
					}))
					.where(
						sql<boolean>`excluded.synced_seq >= case_type_schemas.synced_seq`,
					),
			)
			.returning("case_type")
			.executeTakeFirst();
		if (upserted === undefined) continue;
		retired.push(caseType);
		await tx
			.deleteFrom("case_schema_index_deletions")
			.where("app_id", "=", args.appId)
			.where("case_type", "=", caseType)
			.execute();
	}
	return retired;
}

/**
 * Maintenance-script drain for an inactive schema's empty desired index set.
 * The runtime store owns the general active/inactive drain; this dependency-
 * light form lets the one-off migrator run under plain `tsx` without loading
 * route-only submission modules.
 */
export async function drainRetiredCaseTypeSchemaIndexes(
	db: Kysely<Database>,
	appId: string,
	caseTypes: readonly string[],
): Promise<void> {
	for (const caseType of [...new Set(caseTypes)].sort()) {
		await db.connection().execute(async (connection) => {
			const scope = caseSchemaIndexLockScope(appId, caseType);
			await sql`
				SELECT pg_advisory_lock(hashtextextended(${scope}, 0))
			`.execute(connection);
			try {
				const row = await connection
					.selectFrom("case_type_schemas")
					.select(["is_active", "synced_seq", "index_pending_seq"])
					.where("app_id", "=", appId)
					.where("case_type", "=", caseType)
					.executeTakeFirst();
				if (row === undefined || row.is_active) {
					return;
				}
				const pendingSeq =
					row.index_pending_seq === null
						? undefined
						: safePersistedSequence(
								row.index_pending_seq,
								`case_type_schemas.index_pending_seq for ${appId}/${caseType}`,
							);
				const prefix = `cases\\_${indexScopeTag(appId, caseType)}\\_%`;
				const indexes = await sql<{
					index_name: string;
					index_schema: string;
				}>`
				SELECT index_relation.relname AS index_name,
				       namespace.nspname AS index_schema
				FROM pg_index AS index_row
				JOIN pg_class AS index_relation
				  ON index_relation.oid = index_row.indexrelid
				JOIN pg_namespace AS namespace
				  ON namespace.oid = index_relation.relnamespace
				WHERE index_row.indrelid = to_regclass('cases')
				  AND index_relation.relname LIKE ${prefix} ESCAPE '\\'
				ORDER BY namespace.nspname, index_relation.relname
			`.execute(connection);
				for (const index of indexes.rows) {
					await sql`DROP INDEX CONCURRENTLY IF EXISTS ${sql.id(index.index_schema, index.index_name)}`.execute(
						connection,
					);
				}
				const convergedSeq =
					pendingSeq ??
					safePersistedSequence(
						row.synced_seq,
						`case_type_schemas.synced_seq for forced retirement drain ${appId}/${caseType}`,
					);
				let update = connection
					.updateTable("case_type_schemas")
					.set({ index_pending_seq: null, index_synced_seq: convergedSeq })
					.where("app_id", "=", appId)
					.where("case_type", "=", caseType)
					.where("is_active", "=", false);
				update =
					pendingSeq === undefined
						? update
								.where("synced_seq", "=", String(convergedSeq))
								.where("index_pending_seq", "is", null)
						: update.where("index_pending_seq", "=", String(pendingSeq));
				await update.execute();
			} finally {
				await sql`
					SELECT pg_advisory_unlock(hashtextextended(${scope}, 0))
				`.execute(connection);
			}
		});
	}
}
