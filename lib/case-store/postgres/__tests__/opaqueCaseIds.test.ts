// lib/case-store/postgres/__tests__/opaqueCaseIds.test.ts
//
// Acceptance coverage for opaque case identities: authored non-UUID
// ids — including URL-significant characters — are first-class
// through the storage layer, the identity column family holds its
// widened end state, and the default ordering is the durable
// `(opened_on, case_id)` fact rather than any id-shape assumption.
//
// Same per-test-database idiom as `store.test.ts`: the store's
// transaction-using methods need a real database with no outer
// transaction, and `runCaseStoreMigrations` in `beforeEach` replays
// the full chain — including the `opaque_case_ids` widening — so
// these tests always run against the exact production schema.

import { type Kysely, sql } from "kysely";
import { beforeEach, describe, expect, it } from "vitest";
import type { CaseType } from "@/lib/domain";
import { runCaseStoreMigrations } from "../../migrate";
import { retenantAppCasesOn } from "../../retenant";
import { HeuristicCaseGenerator } from "../../sample/heuristic";
import { setupPerTestDatabase } from "../../sql/__tests__/perTestDatabase";
import type { Database } from "../../sql/database";
import { PostgresCaseStore } from "../store";

const APP_ID = "app-opaque-ids";
const PROJECT_A = "project-a";
const PROJECT_B = "project-b";

/** An authored id exercising every URL-significant shape at once. */
const AUTHORED_ID =
	"nova-case-v1:9ac52723-445f-54a7-8c1b-7e90c985637b:external/1 %x:y+z";
const AUTHORED_PARENT_ID =
	"nova-case-v1:9ac52723-445f-54a7-8c1b-7e90c985637b:household #7";

const dbHandle = setupPerTestDatabase({
	databaseNamePrefix: "opaque_ids_test_",
});

beforeEach(async () => {
	await runCaseStoreMigrations(dbHandle.db);
});

function makeStore(projectId: string): PostgresCaseStore {
	return new PostgresCaseStore({
		projectId,
		actorUserId: projectId,
		db: dbHandle.db as unknown as Kysely<Database>,
		sampleGenerator: new HeuristicCaseGenerator(),
	});
}

const PATIENT: CaseType = {
	name: "patient",
	properties: [{ name: "name", label: "Name", data_type: "text" }],
};
const PATIENT_SCHEMAS: ReadonlyMap<string, CaseType> = new Map([
	[PATIENT.name, PATIENT],
]);

async function seedPatientSchema(store: PostgresCaseStore): Promise<void> {
	await store.applySchemaChange({
		appId: APP_ID,
		caseType: PATIENT.name,
		caseTypeSchemas: PATIENT_SCHEMAS,
	});
}

describe("opaque case ids — storage end state", () => {
	it("holds the widened identity family: text columns, generated-id default, intact FK", async () => {
		const family = await sql<{
			table_name: string;
			column_name: string;
			data_type: string;
		}>`
			SELECT table_name, column_name, data_type FROM information_schema.columns
			 WHERE (table_name, column_name) IN (
				('cases', 'case_id'), ('cases', 'parent_case_id'),
				('case_indices', 'case_id'), ('case_indices', 'ancestor_id'),
				('parked_case_values', 'case_id')
			 )
			 ORDER BY table_name, column_name
		`.execute(dbHandle.db);
		expect(family.rows).toEqual([
			{
				table_name: "case_indices",
				column_name: "ancestor_id",
				data_type: "text",
			},
			{ table_name: "case_indices", column_name: "case_id", data_type: "text" },
			{ table_name: "cases", column_name: "case_id", data_type: "text" },
			{ table_name: "cases", column_name: "parent_case_id", data_type: "text" },
			{
				table_name: "parked_case_values",
				column_name: "case_id",
				data_type: "text",
			},
		]);

		const caseIdDefault = await sql<{ def: string }>`
			SELECT pg_get_expr(d.adbin, d.adrelid) AS def
			  FROM pg_attrdef d
			  JOIN pg_attribute a ON a.attrelid = d.adrelid AND a.attnum = d.adnum
			 WHERE d.adrelid = 'public.cases'::regclass AND a.attname = 'case_id'
		`.execute(dbHandle.db);
		expect(caseIdDefault.rows[0]?.def).toBe("(uuidv7())::text");

		const fk = await sql<{ def: string }>`
			SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint
			 WHERE conname = 'parked_case_values_case_id_fkey'
		`.execute(dbHandle.db);
		expect(fk.rows[0]?.def).toBe(
			"FOREIGN KEY (case_id) REFERENCES cases(case_id) ON DELETE CASCADE",
		);
	});

	it("mints a UUID-shaped text id when no explicit id is supplied", async () => {
		const store = makeStore(PROJECT_A);
		await seedPatientSchema(store);
		const { caseId } = await store.insert({
			appId: APP_ID,
			row: {
				case_type: "patient",
				case_name: "Generated",
				status: "open",
				properties: { name: "Generated" },
			},
		});
		expect(caseId).toMatch(
			/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[0-9a-f]{4}-[0-9a-f]{12}$/,
		);
	});
});

describe("opaque case ids — CRUD, relations, parking, retenancy", () => {
	it("carries an authored URL-significant id through create, read, update, and close", async () => {
		const store = makeStore(PROJECT_A);
		await seedPatientSchema(store);

		const { caseId } = await store.insert({
			appId: APP_ID,
			row: {
				case_id: AUTHORED_ID,
				case_type: "patient",
				case_name: "Authored",
				status: "open",
				properties: { name: "Authored" },
			},
		});
		expect(caseId).toBe(AUTHORED_ID);

		await store.update({
			appId: APP_ID,
			caseId: AUTHORED_ID,
			patch: { properties: { name: "Renamed" } },
		});
		await store.close({ appId: APP_ID, caseId: AUTHORED_ID });

		const row = await sql<{
			case_id: string;
			status: string;
			properties: { name: string };
		}>`
			SELECT case_id, status, properties FROM public.cases
			 WHERE case_id = ${AUTHORED_ID}
		`.execute(dbHandle.db);
		expect(row.rows[0]).toMatchObject({
			case_id: AUTHORED_ID,
			status: "closed",
			properties: { name: "Renamed" },
		});
	});

	it("derives relation edges between authored ids and rebuilds them on reparent", async () => {
		const store = makeStore(PROJECT_A);
		await seedPatientSchema(store);
		await store.insert({
			appId: APP_ID,
			row: {
				case_id: AUTHORED_PARENT_ID,
				case_type: "patient",
				case_name: "Parent",
				status: "open",
				properties: { name: "Parent" },
			},
		});
		await store.insert({
			appId: APP_ID,
			row: {
				case_id: AUTHORED_ID,
				case_type: "patient",
				case_name: "Child",
				status: "open",
				parent_case_id: AUTHORED_PARENT_ID,
				properties: { name: "Child" },
			},
		});

		const edges = await sql<{ case_id: string; ancestor_id: string }>`
			SELECT case_id, ancestor_id FROM public.case_indices
		`.execute(dbHandle.db);
		expect(edges.rows).toEqual([
			{ case_id: AUTHORED_ID, ancestor_id: AUTHORED_PARENT_ID },
		]);

		await store.update({
			appId: APP_ID,
			caseId: AUTHORED_ID,
			patch: { parent_case_id: null },
		});
		const cleared = await sql<{ n: string }>`
			SELECT count(*) AS n FROM public.case_indices
		`.execute(dbHandle.db);
		expect(Number(cleared.rows[0]?.n)).toBe(0);
	});

	it("parks values against an authored id and cascades the park on case deletion", async () => {
		const store = makeStore(PROJECT_A);
		await seedPatientSchema(store);
		await store.insert({
			appId: APP_ID,
			row: {
				case_id: AUTHORED_ID,
				case_type: "patient",
				case_name: "Parked",
				status: "open",
				properties: { name: "Parked" },
			},
		});
		await sql`
			INSERT INTO public.parked_case_values
				(app_id, case_id, case_type, property, original_value, reason)
			VALUES (${APP_ID}, ${AUTHORED_ID}, 'patient', 'name', '"held"'::jsonb, 'test park')
		`.execute(dbHandle.db);

		const held = await sql<{ case_id: string }>`
			SELECT case_id FROM public.parked_case_values
		`.execute(dbHandle.db);
		expect(held.rows).toEqual([{ case_id: AUTHORED_ID }]);

		await sql`DELETE FROM public.cases WHERE case_id = ${AUTHORED_ID}`.execute(
			dbHandle.db,
		);
		const cascaded = await sql<{ n: string }>`
			SELECT count(*) AS n FROM public.parked_case_values
		`.execute(dbHandle.db);
		expect(Number(cascaded.rows[0]?.n)).toBe(0);
	});

	it("re-tenants authored-id rows", async () => {
		const store = makeStore(PROJECT_A);
		await seedPatientSchema(store);
		await store.insert({
			appId: APP_ID,
			row: {
				case_id: AUTHORED_ID,
				case_type: "patient",
				case_name: "Mover",
				status: "open",
				properties: { name: "Mover" },
			},
		});
		const moved = await retenantAppCasesOn(
			dbHandle.db as unknown as Kysely<Database>,
			{ appId: APP_ID, toProjectId: PROJECT_B },
		);
		expect(moved.moved).toBe(1);
		const row = await sql<{ project_id: string }>`
			SELECT project_id FROM public.cases WHERE case_id = ${AUTHORED_ID}
		`.execute(dbHandle.db);
		expect(row.rows[0]?.project_id).toBe(PROJECT_B);
	});
});

describe("opaque case ids — durable default ordering", () => {
	it("orders the unsorted list by (opened_on, case_id), never id shape", async () => {
		const store = makeStore(PROJECT_A);
		await seedPatientSchema(store);
		// Lexically DESCENDING ids with ASCENDING creation times: an
		// id-shape ordering would invert this list; the durable fact
		// keeps creation order. The two same-instant rows tie-break by
		// id ascending.
		const rows = [
			{ id: "zzz-last-id", openedOn: new Date(Date.UTC(2026, 0, 1)) },
			{ id: "mmm-middle-id", openedOn: new Date(Date.UTC(2026, 0, 2)) },
			{ id: "aaa-tie-2", openedOn: new Date(Date.UTC(2026, 0, 3)) },
			{ id: "aaa-tie-1", openedOn: new Date(Date.UTC(2026, 0, 3)) },
		];
		for (const { id, openedOn } of rows) {
			await store.insert({
				appId: APP_ID,
				row: {
					case_id: id,
					case_type: "patient",
					case_name: id,
					status: "open",
					opened_on: openedOn,
					properties: { name: id },
				},
			});
		}
		const listed = await store.query({
			appId: APP_ID,
			caseType: "patient",
			caseTypeSchemas: PATIENT_SCHEMAS,
		});
		expect(listed.map((row) => row.case_id)).toEqual([
			"zzz-last-id",
			"mmm-middle-id",
			"aaa-tie-1",
			"aaa-tie-2",
		]);
	});
});
