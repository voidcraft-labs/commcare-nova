import { type Kysely, sql } from "kysely";
import { beforeEach, describe, expect, it } from "vitest";
import { buildDoc, caseListConfig } from "@/lib/__tests__/docHelpers";
import { decomposeBlueprint } from "@/lib/db/blueprintRows";
import type { AppDatabase } from "@/lib/db/pg";
import { toPersistableDoc } from "@/lib/doc/fieldParent";
import { CASE_CLAIM_CASE_TYPE, type CaseType } from "@/lib/domain";
import { SEARCH_READING } from "@/lib/domain/expression/temporalType";
import { proseText } from "@/lib/domain/prose";
import { findCaseTypeSchemaRetirementFindings } from "../../../../scripts/lib/caseTypeSchemaRetirement";
import { loadPersistedBlueprintReadOnly } from "../../../../scripts/lib/loadPersistedBlueprint";
import { computeSchemaDrift } from "../../../../scripts/lib/schemaDrift";
import { prepareSchemaDriftRepairInAppTransaction } from "../../../../scripts/lib/schemaDriftMigration";
import { buildSimpleBlueprint } from "../../__tests__/fixtures/simpleBlueprint";
import { SchemaNotSyncedError } from "../../errors";
import { HeuristicCaseGenerator } from "../../sample/heuristic";
import { setupPerTestDatabase } from "../../sql/__tests__/perTestDatabase";
import type { Database } from "../../sql/database";
import { buildCaseTypeMap } from "../../store";
import { PostgresCaseStore } from "../store";

const database = setupPerTestDatabase({
	schema: "migrated",
	databaseNamePrefix: "case_index_convergence_",
});
const APP_ID = "index-convergence-app";
const PROJECT_ID = "index-convergence-project";

function db(): Kysely<Database> {
	return database.db as unknown as Kysely<Database>;
}

function store(): PostgresCaseStore {
	return new PostgresCaseStore({
		projectId: PROJECT_ID,
		actorUserId: "index-convergence-actor",
		ownerId: "index-convergence-actor",
		db: db(),
		sampleGenerator: new HeuristicCaseGenerator(),
	});
}

function schema(dataType: "text" | "int"): ReadonlyMap<string, CaseType> {
	return new Map([
		[
			"patient",
			{
				name: "patient",
				properties: [
					{ name: "value", label: proseText("Value"), data_type: dataType },
				],
			},
		],
	]);
}

beforeEach(async () => {
	await sql`
		INSERT INTO apps
			(id, owner, project_id, app_name, app_name_lower)
		VALUES
			(${APP_ID}, 'index-convergence-actor', ${PROJECT_ID},
			 'Index convergence', 'index convergence')
	`.execute(database.db);
});

describe("case-schema lifecycle and drift repair", () => {
	it("does not classify a derived worker schema as an orphaned authored case type", async () => {
		const blueprint = buildSimpleBlueprint([], APP_ID);
		await store().applySchemaChange({
			appId: APP_ID,
			caseType: "commcare-user",
			caseTypeSchemas: buildCaseTypeMap(blueprint),
			syncedSeq: 1,
		});
		expect(
			await findCaseTypeSchemaRetirementFindings(db(), APP_ID, blueprint),
		).toEqual([]);
	});

	it("does not overwrite a newer schema from a stale drift-repair snapshot", async () => {
		const caseStore = store();
		await caseStore.applySchemaChange({
			appId: APP_ID,
			caseType: "patient",
			caseTypeSchemas: schema("text"),
			syncedSeq: 3,
		});
		const desired = toPersistableDoc(
			buildDoc({
				appId: APP_ID,
				appName: "Index convergence",
				caseTypes: [
					{
						name: "patient",
						properties: [
							{
								name: "value",
								label: "Value",
								data_type: "int",
							},
						],
					},
				],
				modules: [
					{
						name: "Patients",
						caseType: "patient",
						caseListMenuItem: {},
						caseListConfig: caseListConfig([
							{ field: "case_name", header: "Name" },
						]),
					},
				],
			}),
		);
		// The search claim's row, which the app holds from its first save.
		await caseStore.applySchemaChange({
			appId: APP_ID,
			caseType: CASE_CLAIM_CASE_TYPE,
			caseTypeSchemas: buildCaseTypeMap(desired),
			syncedSeq: 3,
		});
		const appDb = database.db as unknown as Kysely<AppDatabase>;
		await appDb.transaction().execute(async (tx) => {
			await sql`
				UPDATE apps
				SET app_name = ${desired.appName},
				    app_name_lower = ${desired.appName.toLowerCase()},
				    case_types = ${JSON.stringify(desired.caseTypes)}::jsonb,
				    app_settings = ${JSON.stringify(desired.appSettings)}::jsonb,
				    module_count = ${desired.moduleOrder.length},
				    form_count = 0,
				    mutation_seq = 2
				WHERE id = ${APP_ID}
			`.execute(tx);
			const entities = decomposeBlueprint(desired);
			await tx
				.insertInto("blueprint_entities")
				.values(
					entities.map((entity) => ({
						app_id: APP_ID,
						uuid: entity.uuid,
						kind: entity.kind,
						parent_uuid: entity.parent_uuid,
						ordinal: entity.ordinal,
						data: JSON.stringify(entity.data),
					})),
				)
				.execute();
		});

		const loaded = await appDb
			.transaction()
			.setIsolationLevel("repeatable read")
			.setAccessMode("read only")
			.execute((tx) => loadPersistedBlueprintReadOnly(tx, APP_ID));
		expect(loaded).toEqual(desired);

		const prepared = await appDb
			.transaction()
			.execute((tx) =>
				prepareSchemaDriftRepairInAppTransaction(tx, caseStore, APP_ID),
			);
		expect(prepared?.drifts).toHaveLength(1);

		const stored = await db()
			.selectFrom("case_type_schemas")
			.select(["schema", "synced_seq"])
			.where("app_id", "=", APP_ID)
			.where("case_type", "=", "patient")
			.executeTakeFirstOrThrow();
		expect(stored.synced_seq).toBe("3");
		expect(
			(stored.schema as { properties: { value: { type: string } } }).properties
				.value.type,
		).toBe("string");
	});

	it("schema-drift repair reactivates a current zero-property case type", async () => {
		const caseStore = store();
		const emptySchema = new Map<string, CaseType>([
			["patient", { name: "patient", properties: [] }],
		]);
		const currentBlueprint = buildSimpleBlueprint(
			[...emptySchema.values()],
			APP_ID,
		);
		// The search claim's row, which the app holds from its first save.
		await caseStore.applySchemaChange({
			appId: APP_ID,
			caseType: CASE_CLAIM_CASE_TYPE,
			caseTypeSchemas: buildCaseTypeMap(currentBlueprint),
			syncedSeq: 1,
		});
		await caseStore.applySchemaChange({
			appId: APP_ID,
			caseType: "patient",
			caseTypeSchemas: emptySchema,
			syncedSeq: 1,
		});
		await db()
			.transaction()
			.execute((tx) =>
				caseStore.retireSchemasInTransaction(tx, {
					appId: APP_ID,
					desiredSeq: 2,
					caseTypes: ["patient"],
					fallbackCaseTypeSchemas: emptySchema,
				}),
			);

		expect(await computeSchemaDrift(db(), APP_ID, currentBlueprint)).toEqual([
			{
				caseType: "patient",
				missingRow: true,
				added: [],
				removed: [],
				refined: [],
				retyped: [],
				unresolvable: [],
			},
		]);

		await caseStore.applySchemaChange({
			appId: APP_ID,
			caseType: "patient",
			caseTypeSchemas: emptySchema,
			syncedSeq: 3,
		});
		expect(await computeSchemaDrift(db(), APP_ID, currentBlueprint)).toEqual(
			[],
		);
		expect(
			await findCaseTypeSchemaRetirementFindings(
				db(),
				APP_ID,
				currentBlueprint,
			),
		).toEqual([]);
	});

	it("retires validation atomically, retains rows, and fences a delayed schema sync", async () => {
		const caseStore = store();
		await caseStore.applySchemaChange({
			appId: APP_ID,
			caseType: "patient",
			caseTypeSchemas: schema("text"),
			syncedSeq: 1,
		});
		await caseStore.insert({
			appId: APP_ID,
			row: {
				case_id: "retained-patient",
				case_type: "patient",
				case_name: "Retained patient",
				status: "open",
				properties: { value: "12" },
			},
		});

		await db()
			.transaction()
			.execute((tx) =>
				caseStore.retireSchemasInTransaction(tx, {
					appId: APP_ID,
					desiredSeq: 2,
					caseTypes: ["patient"],
					fallbackCaseTypeSchemas: schema("text"),
				}),
			);
		const retired = await db()
			.selectFrom("case_type_schemas")
			.select(["is_active", "synced_seq"])
			.where("app_id", "=", APP_ID)
			.where("case_type", "=", "patient")
			.executeTakeFirstOrThrow();
		expect(retired).toMatchObject({ is_active: false, synced_seq: "2" });
		expect(
			await findCaseTypeSchemaRetirementFindings(
				db(),
				APP_ID,
				buildSimpleBlueprint([...schema("text").values()], APP_ID),
			),
		).toEqual([
			expect.objectContaining({
				caseType: "patient",
				issues: ["inactive-current-blueprint"],
			}),
		]);
		await expect(
			caseStore.insert({
				appId: APP_ID,
				row: {
					case_id: "post-retirement-write",
					case_type: "patient",
					case_name: "Blocked",
					status: "open",
					properties: { value: "blocked" },
				},
			}),
		).rejects.toBeInstanceOf(SchemaNotSyncedError);
		expect(
			await caseStore.count({
				appId: APP_ID,
				ownerId: "index-convergence-actor",
			}),
		).toBe(1);

		// A pre-retirement post-commit worker arriving late cannot resurrect the
		// type or replace its index target.
		await caseStore.applySchemaChange({
			appId: APP_ID,
			caseType: "patient",
			caseTypeSchemas: schema("text"),
			syncedSeq: 1,
		});
		expect(
			await db()
				.selectFrom("case_type_schemas")
				.select("is_active")
				.where("app_id", "=", APP_ID)
				.where("case_type", "=", "patient")
				.executeTakeFirstOrThrow(),
		).toEqual({ is_active: false });
	});

	it("reactivates from the archived contract and migrates retained values", async () => {
		const caseStore = store();
		await caseStore.applySchemaChange({
			appId: APP_ID,
			caseType: "patient",
			caseTypeSchemas: schema("text"),
			syncedSeq: 1,
		});
		await caseStore.insert({
			appId: APP_ID,
			row: {
				case_id: "reactivated-patient",
				case_type: "patient",
				case_name: "Reactivated patient",
				status: "open",
				properties: { value: "12" },
			},
		});
		await db()
			.transaction()
			.execute((tx) =>
				caseStore.retireSchemasInTransaction(tx, {
					appId: APP_ID,
					desiredSeq: 2,
					caseTypes: ["patient"],
					fallbackCaseTypeSchemas: schema("text"),
				}),
			);

		const report = await caseStore.applySchemaChange({
			appId: APP_ID,
			caseType: "patient",
			caseTypeSchemas: schema("int"),
			syncedSeq: 3,
		});
		expect(report.retyped).toBe(1);
		expect(
			await db()
				.selectFrom("case_type_schemas")
				.select(["is_active", "synced_seq"])
				.where("app_id", "=", APP_ID)
				.where("case_type", "=", "patient")
				.executeTakeFirstOrThrow(),
		).toEqual({ is_active: true, synced_seq: "3" });
		expect(
			(
				await caseStore.query({
					reading: SEARCH_READING,
					appId: APP_ID,
					caseType: "patient",
				})
			)[0]?.properties,
		).toEqual({ value: 12 });
	});

	it("derives reactivation from a previous revision's newer sequence write", async () => {
		const caseStore = store();
		await caseStore.applySchemaChange({
			appId: APP_ID,
			caseType: "patient",
			caseTypeSchemas: schema("text"),
			syncedSeq: 1,
		});
		await db()
			.transaction()
			.execute((tx) =>
				caseStore.retireSchemasInTransaction(tx, {
					appId: APP_ID,
					desiredSeq: 2,
					caseTypes: ["patient"],
					fallbackCaseTypeSchemas: schema("text"),
				}),
			);

		// Exact previous-revision conflict update: it knows only schema +
		// synced_seq. The generated lifecycle must still recognize seq 3 as a
		// legitimate reactivation past retired_seq 2.
		await sql`
			INSERT INTO case_type_schemas
				(app_id, case_type, schema, synced_seq)
			VALUES
				(${APP_ID}, 'patient', ${JSON.stringify({
					type: "object",
					properties: {
						value: {
							type: "integer",
							minimum: -2147483648,
							maximum: 2147483647,
						},
					},
					additionalProperties: false,
				})}::jsonb, 3)
			ON CONFLICT (app_id, case_type) DO UPDATE SET
				schema = excluded.schema,
				synced_seq = excluded.synced_seq
			WHERE excluded.synced_seq >= case_type_schemas.synced_seq
		`.execute(database.db);

		expect(
			await db()
				.selectFrom("case_type_schemas")
				.select(["is_active", "retired_seq", "synced_seq"])
				.where("app_id", "=", APP_ID)
				.where("case_type", "=", "patient")
				.executeTakeFirstOrThrow(),
		).toEqual({ is_active: true, retired_seq: "2", synced_seq: "3" });
		await expect(
			caseStore.insert({
				appId: APP_ID,
				row: {
					case_id: "old-revision-reactivation",
					case_type: "patient",
					case_name: "Reactivated",
					status: "open",
					properties: { value: 3 },
				},
			}),
		).resolves.toBeDefined();
	});
});
