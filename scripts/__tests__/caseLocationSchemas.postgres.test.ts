/**
 * A case type whose catalog declared `location_id` before the location column
 * stored it among its JSON Schema properties. The store now refuses to decode
 * that schema, so every write and schema sync of the type throws, and the sync
 * cannot heal it because it decodes the stored row first. The plausible
 * failure: the repair leaves the stored schema in place, and the case type
 * stays unusable after the deploy.
 */
import { type Kysely, sql } from "kysely";
import { describe, expect, it } from "vitest";
import { buildSimpleBlueprint } from "@/lib/case-store/__tests__/fixtures/simpleBlueprint";
import { PostgresCaseStore } from "@/lib/case-store/postgres/store";
import { HeuristicCaseGenerator } from "@/lib/case-store/sample/heuristic";
import { setupPerTestDatabase } from "@/lib/case-store/sql/__tests__/perTestDatabase";
import type { Database } from "@/lib/case-store/sql/database";
import { buildCaseTypeMap } from "@/lib/case-store/store";
import type { CaseType } from "@/lib/domain";
import { proseText } from "@/lib/domain/prose";
import {
	migrateCaseLocationSchemas,
	scanCaseLocationSchemas,
} from "../lib/caseLocationProperties";

const APP_ID = "location-schema-app";
const PROJECT = "location-schema-project";
const ACTOR = "worker-1";
const PATIENT: CaseType = {
	name: "patient",
	properties: [{ name: "notes", label: proseText("Notes"), data_type: "text" }],
};
const SCHEMAS = buildCaseTypeMap(buildSimpleBlueprint([PATIENT], APP_ID));

const dbHandle = setupPerTestDatabase({
	schema: "migrated",
	databaseNamePrefix: "location_schema_test_",
	prepareTemplate: async (db) => {
		await sql`
			INSERT INTO apps (id, owner, project_id, app_name, app_name_lower)
			VALUES (${APP_ID}, ${ACTOR}, ${PROJECT}, 'Location app', 'location app')
		`.execute(db);
	},
});

function makeStore() {
	return new PostgresCaseStore({
		projectId: PROJECT,
		actorUserId: ACTOR,
		ownerId: ACTOR,
		db: dbHandle.db as Kysely<Database>,
		sampleGenerator: new HeuristicCaseGenerator(),
	});
}

const insertPatient = (store: PostgresCaseStore, caseId: string) =>
	store.insert({
		appId: APP_ID,
		row: {
			case_id: caseId,
			case_type: "patient",
			case_name: "Alice",
			status: "open",
			properties: JSON.stringify({ notes: "seen" }),
		},
	});

describe("a stored case schema that declares location_id", () => {
	it("is repaired so the case type writes and syncs again", async () => {
		const store = makeStore();
		const db = dbHandle.db as Kysely<Database>;
		await store.applySchemaChange({
			appId: APP_ID,
			caseType: "patient",
			caseTypeSchemas: SCHEMAS,
		});
		// The schema a catalog declaring `location_id` stored before the column.
		await sql`
			UPDATE case_type_schemas
			SET schema = jsonb_set(schema, '{properties,location_id}', '{"type":"string"}')
			WHERE app_id = ${APP_ID} AND case_type = 'patient'
		`.execute(db);
		await expect(
			insertPatient(store, "00000000-0000-7000-8000-000000000001"),
		).rejects.toThrow(/reserved scalar "location_id"/);

		expect(await scanCaseLocationSchemas(db)).toEqual([
			{ appId: APP_ID, caseType: "patient", active: true },
		]);
		expect(await migrateCaseLocationSchemas(db)).toBe(1);
		expect(await migrateCaseLocationSchemas(db)).toBe(0);
		expect(await scanCaseLocationSchemas(db)).toEqual([]);

		const repaired = makeStore();
		await insertPatient(repaired, "00000000-0000-7000-8000-000000000002");
		await repaired.applySchemaChange({
			appId: APP_ID,
			caseType: "patient",
			caseTypeSchemas: SCHEMAS,
		});
		const row = await db
			.selectFrom("case_type_schemas")
			.select("schema")
			.where("app_id", "=", APP_ID)
			.where("case_type", "=", "patient")
			.executeTakeFirstOrThrow();
		expect(
			(row.schema as { properties: Record<string, unknown> }).properties,
		).toHaveProperty("notes");
	});
});
