import { type Kysely, sql } from "kysely";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { buildDoc, caseListConfig } from "@/lib/__tests__/docHelpers";
import { decomposeBlueprint } from "@/lib/db/blueprintRows";
import type { AppDatabase } from "@/lib/db/pg";
import { toPersistableDoc } from "@/lib/doc/fieldParent";
import type { CaseType } from "@/lib/domain";
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
import { drainRetiredCaseTypeSchemaIndexes } from "../schemaRetirement";
import { indexScopeTag, PostgresCaseStore, propertyIndexTag } from "../store";

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

function indexName(suffix: "fuzzy" | "int"): string {
	return `cases_${indexScopeTag(APP_ID, "patient")}_${propertyIndexTag("value")}_${suffix}`;
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

describe("durable case-schema index convergence", () => {
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
						caseListOnly: true,
						caseListConfig: caseListConfig([
							{ field: "case_name", header: "Name" },
						]),
					},
				],
			}),
		);
		const appDb = database.db as unknown as Kysely<AppDatabase>;
		await appDb.transaction().execute(async (tx) => {
			await sql`
				UPDATE apps
				SET app_name = ${desired.appName},
				    app_name_lower = ${desired.appName.toLowerCase()},
				    case_types = ${JSON.stringify(desired.caseTypes)}::jsonb,
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

		const prepared = await appDb
			.transaction()
			.execute((tx) =>
				prepareSchemaDriftRepairInAppTransaction(tx, caseStore, APP_ID),
			);
		expect(prepared?.drifts).toHaveLength(1);
		await prepared?.completeAfterCommit();

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

	it("loads the exact Blueprint in a nonlocking read-only snapshot", async () => {
		const appDb = database.db as unknown as Kysely<AppDatabase>;
		const blueprint = await appDb
			.transaction()
			.setIsolationLevel("repeatable read")
			.setAccessMode("read only")
			.execute((tx) => loadPersistedBlueprintReadOnly(tx, APP_ID));

		expect(blueprint).toMatchObject({
			appName: "Index convergence",
		});
	});

	it("audits residual indexes after production relocates cases out of public", async () => {
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
				caseStore.retireSchemasPhaseA(tx, {
					appId: APP_ID,
					desiredSeq: 2,
					caseTypes: ["patient"],
					fallbackCaseTypeSchemas: schema("text"),
				}),
			);

		// Reproduce the overlap failure this audit must detect: an older
		// worker consumed the marker without dropping the physical index.
		await db()
			.updateTable("case_type_schemas")
			.set({ index_pending_seq: null })
			.where("app_id", "=", APP_ID)
			.where("case_type", "=", "patient")
			.execute();

		const isolated = "nova_case_runtime";
		await database.pool.query(`CREATE SCHEMA ${isolated}`);
		await database.pool.query(
			`ALTER TABLE public.cases SET SCHEMA ${isolated}`,
		);
		await database.pool.query(
			`ALTER DATABASE ${database.databaseName} SET search_path TO public, ${isolated}`,
		);
		await database.pool.query(`SET search_path TO public, ${isolated}`);

		const placement = await database.pool.query<{
			current_schema: string;
			cases_schema: string;
		}>(`
			SELECT current_schema(),
			       (SELECT namespace.nspname
			          FROM pg_class AS relation
			          JOIN pg_namespace AS namespace
			            ON namespace.oid = relation.relnamespace
			         WHERE relation.oid = to_regclass('cases')) AS cases_schema
		`);
		expect(placement.rows[0]).toEqual({
			current_schema: "public",
			cases_schema: isolated,
		});

		expect(
			await findCaseTypeSchemaRetirementFindings(
				db(),
				APP_ID,
				buildSimpleBlueprint([], APP_ID),
			),
		).toEqual([
			expect.objectContaining({
				caseType: "patient",
				issues: ["inactive-index-cleanup"],
				expressionIndexCount: 1,
			}),
		]);

		// Index names are schema-local. A public collision must survive while
		// maintenance drops the identically named index attached to the relocated
		// production cases table.
		await sql`CREATE TABLE public.retirement_index_decoy (id text)`.execute(
			database.db,
		);
		await sql`
			CREATE INDEX ${sql.id(indexName("fuzzy"))}
			ON public.retirement_index_decoy (id)
		`.execute(database.db);
		await drainRetiredCaseTypeSchemaIndexes(db(), APP_ID, ["patient"]);
		const remaining = await sql<{
			public_index: string | null;
			runtime_index: string | null;
		}>`
			SELECT to_regclass(${`public.${indexName("fuzzy")}`})::text AS public_index,
			       to_regclass(${`${isolated}.${indexName("fuzzy")}`})::text AS runtime_index
		`.execute(database.db);
		expect(remaining.rows[0]).toEqual({
			public_index: indexName("fuzzy"),
			runtime_index: null,
		});
		expect(
			await findCaseTypeSchemaRetirementFindings(
				db(),
				APP_ID,
				buildSimpleBlueprint([], APP_ID),
			),
		).toEqual([]);
	});

	it("reactivates across a numeric index collision in the relocated production schema", async () => {
		const caseStore = store();
		await caseStore.applySchemaChange({
			appId: APP_ID,
			caseType: "patient",
			caseTypeSchemas: schema("int"),
			syncedSeq: 1,
		});
		await caseStore.insert({
			appId: APP_ID,
			row: {
				case_id: "numeric-retained-patient",
				case_type: "patient",
				case_name: "Numeric retained patient",
				status: "open",
				properties: { value: 12 },
			},
		});
		const retirement = await db()
			.transaction()
			.execute((tx) =>
				caseStore.retireSchemasPhaseA(tx, {
					appId: APP_ID,
					desiredSeq: 2,
					caseTypes: ["patient"],
					fallbackCaseTypeSchemas: schema("int"),
				}),
			);

		const isolated = "nova_case_runtime_reactivation";
		await database.pool.query(`CREATE SCHEMA ${isolated}`);
		await database.pool.query(
			`ALTER TABLE public.cases SET SCHEMA ${isolated}`,
		);
		await database.pool.query(
			`ALTER DATABASE ${database.databaseName} SET search_path TO public, ${isolated}`,
		);
		await database.pool.query(`SET search_path TO public, ${isolated}`);
		await sql`CREATE TABLE public.numeric_index_decoy (id integer)`.execute(
			database.db,
		);
		await sql`
			CREATE INDEX ${sql.id(indexName("int"))}
			ON public.numeric_index_decoy (id)
		`.execute(database.db);

		await caseStore.applySchemaChange({
			appId: APP_ID,
			caseType: "patient",
			caseTypeSchemas: schema("text"),
			syncedSeq: 3,
		});
		// A delayed retirement completion must observe the newer active row and
		// leave its new fuzzy index intact.
		await retirement.completeAfterCommit();

		const indexes = await sql<{
			public_int: string | null;
			runtime_fuzzy: string | null;
			runtime_int: string | null;
		}>`
			SELECT to_regclass(${`public.${indexName("int")}`})::text AS public_int,
			       to_regclass(${`${isolated}.${indexName("int")}`})::text AS runtime_int,
			       to_regclass(${`${isolated}.${indexName("fuzzy")}`})::text AS runtime_fuzzy
		`.execute(database.db);
		expect(indexes.rows[0]).toEqual({
			public_int: indexName("int"),
			runtime_int: null,
			runtime_fuzzy: indexName("fuzzy"),
		});
		const retained = await db()
			.selectFrom("cases")
			.select("properties")
			.where("app_id", "=", APP_ID)
			.where("case_id", "=", "numeric-retained-patient")
			.executeTakeFirstOrThrow();
		expect(retained.properties).toEqual({ value: "12" });
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
		await caseStore.applySchemaChange({
			appId: APP_ID,
			caseType: "patient",
			caseTypeSchemas: emptySchema,
			syncedSeq: 1,
		});
		await db()
			.transaction()
			.execute((tx) =>
				caseStore.retireSchemasPhaseA(tx, {
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

	it("scans historical candidates and the maintenance drain converges them", async () => {
		const caseStore = store();
		await caseStore.applySchemaChange({
			appId: APP_ID,
			caseType: "patient",
			caseTypeSchemas: schema("text"),
			syncedSeq: 1,
		});
		const retiredBlueprint = buildSimpleBlueprint([], APP_ID);
		expect(
			await findCaseTypeSchemaRetirementFindings(
				db(),
				APP_ID,
				retiredBlueprint,
			),
		).toEqual([
			expect.objectContaining({
				caseType: "patient",
				issues: ["active-without-blueprint"],
				caseCount: 0,
				expressionIndexCount: 1,
			}),
		]);

		const prepared = await db()
			.transaction()
			.execute((tx) =>
				caseStore.retireSchemasPhaseA(tx, {
					appId: APP_ID,
					desiredSeq: 2,
					caseTypes: ["patient"],
					fallbackCaseTypeSchemas: schema("text"),
				}),
			);
		await drainRetiredCaseTypeSchemaIndexes(db(), APP_ID, prepared.caseTypes);
		expect(
			await findCaseTypeSchemaRetirementFindings(
				db(),
				APP_ID,
				retiredBlueprint,
			),
		).toEqual([]);
		expect(
			(
				await sql<{ present: boolean }>`
					SELECT to_regclass(${indexName("fuzzy")}) IS NOT NULL AS present
				`.execute(database.db)
			).rows[0]?.present,
		).toBe(false);
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

		const prepared = await db()
			.transaction()
			.execute((tx) =>
				caseStore.retireSchemasPhaseA(tx, {
					appId: APP_ID,
					desiredSeq: 2,
					caseTypes: ["patient"],
					fallbackCaseTypeSchemas: schema("text"),
				}),
			);
		const retired = await db()
			.selectFrom("case_type_schemas")
			.select(["is_active", "synced_seq", "index_pending_seq"])
			.where("app_id", "=", APP_ID)
			.where("case_type", "=", "patient")
			.executeTakeFirstOrThrow();
		expect(retired).toMatchObject({ is_active: false, synced_seq: "2" });
		expect(Number(retired.index_pending_seq)).toBe(2);
		expect(
			await findCaseTypeSchemaRetirementFindings(
				db(),
				APP_ID,
				buildSimpleBlueprint([...schema("text").values()], APP_ID),
			),
		).toEqual([
			expect.objectContaining({
				caseType: "patient",
				issues: ["inactive-current-blueprint", "inactive-index-cleanup"],
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

		await prepared.completeAfterCommit();
		expect(
			(
				await sql<{ present: boolean }>`
					SELECT to_regclass(${indexName("fuzzy")}) IS NOT NULL AS present
				`.execute(database.db)
			).rows[0]?.present,
		).toBe(false);
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
		const prepared = await db()
			.transaction()
			.execute((tx) =>
				caseStore.retireSchemasPhaseA(tx, {
					appId: APP_ID,
					desiredSeq: 2,
					caseTypes: ["patient"],
					fallbackCaseTypeSchemas: schema("text"),
				}),
			);
		await prepared.completeAfterCommit();

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
			(await caseStore.query({ appId: APP_ID, caseType: "patient" }))[0]
				?.properties,
		).toEqual({ value: 12 });
		expect(
			(
				await sql<{ present: boolean }>`
					SELECT to_regclass(${indexName("int")}) IS NOT NULL AS present
				`.execute(database.db)
			).rows[0]?.present,
		).toBe(true);
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
				caseStore.retireSchemasPhaseA(tx, {
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
		await db()
			.updateTable("case_type_schemas")
			.set({ index_pending_seq: 3 })
			.where("app_id", "=", APP_ID)
			.where("case_type", "=", "patient")
			.execute();

		expect(
			await db()
				.selectFrom("case_type_schemas")
				.select(["is_active", "retired_seq", "synced_seq"])
				.where("app_id", "=", APP_ID)
				.where("case_type", "=", "patient")
				.executeTakeFirstOrThrow(),
		).toEqual({ is_active: true, retired_seq: "2", synced_seq: "3" });
		await caseStore.drainPendingIndexConvergence({
			appId: APP_ID,
			caseTypes: ["patient"],
		});
		expect(
			(
				await sql<{ present: boolean }>`
					SELECT to_regclass(${indexName("int")}) IS NOT NULL AS present
				`.execute(database.db)
			).rows[0]?.present,
		).toBe(true);
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

	it("audits and force-drains retired indexes even when pending state was consumed", async () => {
		const caseStore = store();
		await caseStore.applySchemaChange({
			appId: APP_ID,
			caseType: "patient",
			caseTypeSchemas: schema("text"),
			syncedSeq: 1,
		});
		const retiredBlueprint = buildSimpleBlueprint([], APP_ID);
		const prepared = await db()
			.transaction()
			.execute((tx) =>
				caseStore.retireSchemasPhaseA(tx, {
					appId: APP_ID,
					desiredSeq: 2,
					caseTypes: ["patient"],
					fallbackCaseTypeSchemas: schema("text"),
				}),
			);
		await db()
			.updateTable("case_type_schemas")
			.set({ index_pending_seq: null })
			.where("app_id", "=", APP_ID)
			.where("case_type", "=", "patient")
			.execute();

		expect(
			await findCaseTypeSchemaRetirementFindings(
				db(),
				APP_ID,
				retiredBlueprint,
			),
		).toEqual([
			expect.objectContaining({
				caseType: "patient",
				issues: ["inactive-index-cleanup"],
				expressionIndexCount: 1,
			}),
		]);

		// The hot-path drain handles durable queue markers only. Persisted
		// inactive history must not become permanent catalog work on every case
		// operation after its marker has cleared.
		await caseStore.drainPendingIndexConvergence({ appId: APP_ID });
		expect(
			await findCaseTypeSchemaRetirementFindings(
				db(),
				APP_ID,
				retiredBlueprint,
			),
		).toEqual([
			expect.objectContaining({
				caseType: "patient",
				issues: ["inactive-index-cleanup"],
				expressionIndexCount: 1,
			}),
		]);
		await prepared.completeAfterCommit();
		expect(
			await db()
				.selectFrom("case_type_schemas")
				.select(["synced_seq", "index_synced_seq", "index_pending_seq"])
				.where("app_id", "=", APP_ID)
				.where("case_type", "=", "patient")
				.executeTakeFirstOrThrow(),
		).toEqual({
			synced_seq: "2",
			index_synced_seq: "2",
			index_pending_seq: null,
		});
		expect(
			await findCaseTypeSchemaRetirementFindings(
				db(),
				APP_ID,
				retiredBlueprint,
			),
		).toEqual([]);
	});

	it("retains a deletion tombstone across Phase-B failure and the global drain finishes it", async () => {
		const caseStore = store();
		await caseStore.applySchemaChange({
			appId: APP_ID,
			caseType: "patient",
			caseTypeSchemas: schema("text"),
			syncedSeq: 1,
		});

		type PrivateSync = (args: unknown) => Promise<void>;
		const privateStore = caseStore as unknown as {
			syncExpressionIndexes: PrivateSync;
		};
		const syncSpy = vi
			.spyOn(privateStore, "syncExpressionIndexes")
			.mockRejectedValueOnce(new Error("injected index DDL failure"));

		await expect(
			caseStore.purgeSchemaForMaintenance({
				appId: APP_ID,
				caseType: "patient",
			}),
		).rejects.toThrow("injected index DDL failure");
		expect(
			await db()
				.selectFrom("case_type_schemas")
				.select("case_type")
				.where("app_id", "=", APP_ID)
				.where("case_type", "=", "patient")
				.executeTakeFirst(),
		).toBeUndefined();
		expect(
			await db()
				.selectFrom("case_schema_index_deletions")
				.select("case_type")
				.where("app_id", "=", APP_ID)
				.where("case_type", "=", "patient")
				.executeTakeFirst(),
		).toEqual({ case_type: "patient" });
		expect(
			(
				await sql<{ present: boolean }>`
					SELECT to_regclass(${indexName("fuzzy")}) IS NOT NULL AS present
				`.execute(database.db)
			).rows[0]?.present,
		).toBe(true);

		syncSpy.mockRestore();
		await caseStore.drainAllPendingIndexConvergence();
		expect(
			await db()
				.selectFrom("case_schema_index_deletions")
				.select("case_type")
				.where("app_id", "=", APP_ID)
				.where("case_type", "=", "patient")
				.executeTakeFirst(),
		).toBeUndefined();
		expect(
			(
				await sql<{ present: boolean }>`
					SELECT to_regclass(${indexName("fuzzy")}) IS NOT NULL AS present
				`.execute(database.db)
			).rows[0]?.present,
		).toBe(false);
	});

	it("rebuilds a valid same-name index whose physical definition is wrong", async () => {
		const caseStore = store();
		await caseStore.applySchemaChange({
			appId: APP_ID,
			caseType: "patient",
			caseTypeSchemas: schema("int"),
			syncedSeq: 1,
		});
		const name = indexName("int");
		await sql`DROP INDEX ${sql.id(name)}`.execute(database.db);
		await sql`
			CREATE INDEX ${sql.id(name)}
			ON cases USING btree ((properties->>'value'))
			WHERE app_id = ${sql.lit(APP_ID)}
			  AND case_type = ${sql.lit("wrong-type")}
		`.execute(database.db);

		await caseStore.applySchemaChange({
			appId: APP_ID,
			caseType: "patient",
			caseTypeSchemas: schema("int"),
			syncedSeq: 2,
		});

		const definition = await sql<{ definition: string }>`
			SELECT pg_get_indexdef(to_regclass(${name})) AS definition
		`.execute(database.db);
		expect(definition.rows[0]?.definition).toContain("::integer");
		expect(definition.rows[0]?.definition).toContain(
			`case_type = 'patient'::text`,
		);
	});

	it("rejects a malformed stored property declaration and leaves it pending", async () => {
		const caseStore = store();
		await caseStore.applySchemaChange({
			appId: APP_ID,
			caseType: "patient",
			caseTypeSchemas: schema("text"),
			syncedSeq: 1,
		});
		await db()
			.updateTable("case_type_schemas")
			.set({
				schema: JSON.stringify({
					type: "object",
					properties: { value: { type: "mystery" } },
					additionalProperties: false,
				}),
				index_pending_seq: 2,
			})
			.where("app_id", "=", APP_ID)
			.where("case_type", "=", "patient")
			.execute();

		await expect(
			caseStore.drainPendingIndexConvergence({ appId: APP_ID }),
		).rejects.toThrow(/unknown or noncanonical property declaration/);
		const pending = await db()
			.selectFrom("case_type_schemas")
			.select("index_pending_seq")
			.where("app_id", "=", APP_ID)
			.where("case_type", "=", "patient")
			.executeTakeFirstOrThrow();
		expect(Number(pending.index_pending_seq)).toBe(2);
	});

	it.each([
		{
			name: "invalid property key",
			properties: { "bad key": { type: "string" } },
			message: /contains characters other than/,
		},
		{
			name: "reserved scalar property",
			properties: { case_name: { type: "string" } },
			message: /declares reserved scalar "case_name"/,
		},
	])("rejects a $name in a stored schema", async (fixture) => {
		const caseStore = store();
		await caseStore.applySchemaChange({
			appId: APP_ID,
			caseType: "patient",
			caseTypeSchemas: schema("text"),
			syncedSeq: 1,
		});
		await db()
			.updateTable("case_type_schemas")
			.set({
				schema: JSON.stringify({
					type: "object",
					properties: fixture.properties,
					additionalProperties: false,
				}),
				index_pending_seq: 2,
			})
			.where("app_id", "=", APP_ID)
			.where("case_type", "=", "patient")
			.execute();

		await expect(
			caseStore.drainPendingIndexConvergence({ appId: APP_ID }),
		).rejects.toThrow(fixture.message);
		expect(
			Number(
				(
					await db()
						.selectFrom("case_type_schemas")
						.select("index_pending_seq")
						.where("app_id", "=", APP_ID)
						.where("case_type", "=", "patient")
						.executeTakeFirstOrThrow()
				).index_pending_seq,
			),
		).toBe(2);
	});
});
