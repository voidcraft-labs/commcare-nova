import { sql, type Transaction } from "kysely";
import { buildCaseTypeMap } from "@/lib/case-store";
import { withAppTestNamespace } from "@/lib/case-store/appTestNamespace";
import type { Database } from "@/lib/case-store/sql/database";
import type { AppTestScope } from "@/lib/db/appTests";
import type { AppDatabase } from "@/lib/db/pg";
import { hydratePersistedBlueprint } from "@/lib/doc/fieldParent";
import { asUuid, ownRecordValue } from "@/lib/domain";
import { caseTypeToJsonSchema } from "@/lib/domain/predicate/jsonSchema";
import { balancedKeysBetween } from "@/lib/lookup/orderKeys";
import {
	assertLocationPlacementsValid,
	assertLocationValuesValid,
	assertPersonaAssignmentsValid,
} from "@/lib/organization/commitIntegrity";
import { evaluationScenarioCases } from "@/lib/preview/engine/evaluationScenario";
import type { AppTestSnapshot, AppTestStartInput } from "./types";

/** Seed only explicitly supplied test records and pinned authorized lookup
 * rows. No real case rows are copied implicitly and no external writer runs. */
export async function seedAppTest(
	tx: Transaction<AppDatabase>,
	scope: AppTestScope & { testId: string; blueprintSeq: number },
	snapshot: AppTestSnapshot,
	input: AppTestStartInput,
) {
	const doc = hydratePersistedBlueprint(snapshot.blueprint);
	const types = buildCaseTypeMap(doc);
	const cases = evaluationScenarioCases(
		doc,
		scope.actorUserId,
		input.scenario ?? { records: [] },
	);
	const owners = new Map<string, string>();
	for (const assignment of input.owners ?? []) {
		if (
			owners.has(assignment.recordId) ||
			!cases.rows.some((row) => row.case_id === assignment.recordId)
		)
			throw new Error(
				"Each record owner must name one supplied test record, once.",
			);
		const owner = assignment.owner;
		if (
			owner.kind === "persona" &&
			!ownRecordValue(doc.personas ?? {}, owner.personaUuid)
		)
			throw new Error(
				"A test record owner names a Preview identity that is not saved in the app.",
			);
		if (
			owner.kind === "place" &&
			!snapshot.locations.some(
				(location) =>
					location.id === owner.locationUuid && location.archivedAt === null,
			)
		)
			throw new Error("A test record owner names an unavailable place.");
		owners.set(
			assignment.recordId,
			owner.kind === "me"
				? scope.actorUserId
				: owner.kind === "persona"
					? owner.personaUuid
					: owner.locationUuid,
		);
	}
	const caseTx = tx as unknown as Transaction<Database>;
	await withAppTestNamespace(
		caseTx,
		{ ...scope, ownerId: scope.actorUserId },
		async (_store, isolated) => {
			await sql`INSERT INTO apps (id, owner, project_id, app_name, app_name_lower, mutation_seq)
			VALUES (${scope.appId}, ${scope.actorUserId}, ${scope.projectId}, ${doc.appName}, ${doc.appName.toLowerCase()}, ${scope.blueprintSeq})`.execute(
				isolated,
			);
			for (const [name, type] of types) {
				await isolated
					.insertInto("case_type_schemas")
					.values({
						app_id: scope.appId,
						case_type: name,
						schema: JSON.stringify(caseTypeToJsonSchema(type)),
						synced_seq: scope.blueprintSeq,
					})
					.execute();
			}
			if (snapshot.locations.length > 0) {
				await isolated
					.insertInto("app_locations")
					.values(
						snapshot.locations.map((location) => ({
							id: location.id,
							app_id: scope.appId,
							level_uuid: asUuid(location.levelUuid),
							parent_id: location.parentId,
							name: location.name,
							site_code: location.siteCode,
							external_id: location.externalId,
							latitude: location.latitude,
							longitude: location.longitude,
							values: JSON.stringify(location.values),
							archived_at: location.archivedAt,
							order_key: location.orderKey,
							created_by: scope.actorUserId,
							updated_by: scope.actorUserId,
						})),
					)
					.execute();
			}
			const organizationTx = isolated as unknown as Transaction<AppDatabase>;
			await assertLocationPlacementsValid(organizationTx, {
				appId: scope.appId,
				candidateDoc: doc,
			});
			await assertLocationValuesValid(organizationTx, {
				appId: scope.appId,
				candidateDoc: doc,
			});
			await assertPersonaAssignmentsValid(organizationTx, {
				appId: scope.appId,
				candidateDoc: doc,
			});
			for (const [tableId, rows] of snapshot.lookup.rows) {
				const rowOrder = balancedKeysBetween(null, null, rows.length);
				for (let offset = 0; offset < rows.length; offset += 500) {
					await isolated
						.insertInto("lookup_rows")
						.values(
							rows.slice(offset, offset + 500).map((row, index) => ({
								project_id: scope.projectId,
								table_id: tableId,
								id: row.id,
								order_key: rowOrder[offset + index],
								values: JSON.stringify(row.values),
								created_by: scope.actorUserId,
								updated_by: scope.actorUserId,
							})),
						)
						.execute();
				}
			}
		},
	);
	const pending = new Map(cases.rows.map((row) => [row.case_id, row]));
	while (pending.size > 0) {
		let inserted = false;
		for (const [id, row] of pending) {
			if (row.parent_case_id !== null && pending.has(row.parent_case_id))
				continue;
			await withAppTestNamespace(
				caseTx,
				{ ...scope, ownerId: owners.get(id) ?? scope.actorUserId },
				async (store) => {
					const { app_id: _app, owner_id: _owner, ...record } = row;
					await store.insert({
						appId: scope.appId,
						row: record,
						parentRelationship:
							types.get(row.case_type)?.relationship ?? "child",
					});
				},
			);
			pending.delete(id);
			inserted = true;
		}
		if (!inserted) throw new Error("The test records contain a parent cycle.");
	}
}
