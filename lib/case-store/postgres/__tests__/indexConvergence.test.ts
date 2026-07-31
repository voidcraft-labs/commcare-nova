import { type Kysely, sql } from "kysely";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CaseType } from "@/lib/domain";
import { proseText } from "@/lib/domain/prose";
import { runCaseStoreMigrations } from "../../migrate";
import { HeuristicCaseGenerator } from "../../sample/heuristic";
import { setupPerTestDatabase } from "../../sql/__tests__/perTestDatabase";
import type { Database } from "../../sql/database";
import { indexScopeTag, PostgresCaseStore, propertyIndexTag } from "../store";

const database = setupPerTestDatabase({
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
	await runCaseStoreMigrations(database.db);
	await sql`
		INSERT INTO apps
			(id, owner, project_id, app_name, app_name_lower)
		VALUES
			(${APP_ID}, 'index-convergence-actor', ${PROJECT_ID},
			 'Index convergence', 'index convergence')
	`.execute(database.db);
});

describe("durable case-schema index convergence", () => {
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
			caseStore.dropSchema({ appId: APP_ID, caseType: "patient" }),
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
