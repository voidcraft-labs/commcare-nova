// The real Preview query binding against PostgreSQL, with authored filter,
// ordered sorts and calculated values. Pure authoring/wire checks live next door.
import { type Kysely, sql } from "kysely";
import { beforeEach, describe, expect, it } from "vitest";
import { buildCaseTypeMap, type CaseStore } from "@/lib/case-store";
import { PostgresCaseStore } from "@/lib/case-store/postgres/store";
import { HeuristicCaseGenerator } from "@/lib/case-store/sample/heuristic";
import { setupPerTestDatabase } from "@/lib/case-store/sql/__tests__/perTestDatabase";
import type { Database } from "@/lib/case-store/sql/database";
import { readCases } from "@/lib/preview/engine/caseDataBindingHelpers";
import {
	APP_ID,
	buildFixtureDoc,
	COL_AGE_NEXT_UUID,
	OWNER_ID,
	PATIENT_ALICE_ID,
	PATIENT_BOB_ID,
	PATIENT_CAROL_ID,
} from "./fixtures/caseListAuthoring";

const PROJECT_ID = "case-list-project";
const dbHandle = setupPerTestDatabase({
	schema: "migrated",
	databaseNamePrefix: "case_list_int_",
});
function buildStore(): CaseStore {
	return new PostgresCaseStore({
		projectId: PROJECT_ID,
		actorUserId: OWNER_ID,
		ownerId: OWNER_ID,
		db: dbHandle.db as unknown as Kysely<Database>,
		sampleGenerator: new HeuristicCaseGenerator(),
	});
}

describe("preview rendering (PostgresCaseStore.query against v2 caseListConfig)", () => {
	beforeEach(async () => {
		await sql`
			INSERT INTO apps
				(id, owner, project_id, app_name, app_name_lower)
			VALUES
				(${APP_ID}, ${OWNER_ID}, ${PROJECT_ID}, 'Case list authoring', 'case list authoring')
		`.execute(dbHandle.db);
	});

	it("filters, sorts, and projects calc values per the authored config", async () => {
		const store = buildStore();
		const doc = buildFixtureDoc();
		await store.applySchemaChange({
			appId: APP_ID,
			caseType: "patient",
			caseTypeSchemas: buildCaseTypeMap(doc),
		});

		// Alice — open, age 25. Filter passes; calc = 26.
		await store.insert({
			appId: APP_ID,
			row: {
				case_id: PATIENT_ALICE_ID,
				case_type: "patient",
				case_name: "Alice",
				status: "open",
				properties: { full_name: "Alice", age: 25, region: "N" },
			},
		});
		// Bob — open, age 40. Filter passes; calc = 41.
		await store.insert({
			appId: APP_ID,
			row: {
				case_id: PATIENT_BOB_ID,
				case_type: "patient",
				case_name: "Bob",
				status: "open",
				properties: { full_name: "Bob", age: 40, region: "S" },
			},
		});
		// Carol — closed, age 30. Filter rejects.
		await store.insert({
			appId: APP_ID,
			row: {
				case_id: PATIENT_CAROL_ID,
				case_type: "patient",
				case_name: "Carol",
				status: "closed",
				properties: { full_name: "Carol", age: 30, region: "N" },
			},
		});

		await store.insert({
			appId: APP_ID,
			row: {
				case_id: "30000000-0000-0000-0000-000000000004",
				case_type: "patient",
				case_name: "Aaron",
				status: "open",
				properties: { full_name: "Aaron", age: 40, region: "N" },
			},
		});

		const moduleUuid = doc.moduleOrder[0];
		const mod = doc.modules[moduleUuid];
		if (!mod) throw new Error("missing patients module");

		// Read through the preview helper — it lowers the v2 config
		// into the v2 case-store API surface (calc projections,
		// per-column sort + tie-break, predicate filter).
		const result = await readCases(store, {
			appId: APP_ID,
			caseType: "patient",
			caseTypeSchemas: buildCaseTypeMap(doc),
			caseListConfig: mod.caseListConfig,
		});
		if (result.kind !== "rows") {
			throw new Error("expected rows from preview");
		}
		expect(
			result.rows.map((row) => ({
				id: row.case_id,
				name: row.case_name,
				status: row.status,
				nextAge: Number(row.calculated[COL_AGE_NEXT_UUID]),
			})),
		).toEqual([
			{
				id: "30000000-0000-0000-0000-000000000004",
				name: "Aaron",
				status: "open",
				nextAge: 41,
			},
			{ id: PATIENT_BOB_ID, name: "Bob", status: "open", nextAge: 41 },
			{ id: PATIENT_ALICE_ID, name: "Alice", status: "open", nextAge: 26 },
		]);
	});
});
