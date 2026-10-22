// lib/preview/engine/__tests__/searchResultsSnapshot.postgres.test.ts
//
// What a completed search returns to the forms of its search-first module,
// against real Postgres through the helper the Server Action calls
// (`readSearchResultsSnapshot`).
//
// HQ's case search finds the Project's open cases of the module's type, bound
// by no restore, and sends a device at most 500 of them
// (`case_search/utils.py::CaseSearchQueryBuilder._get_initial_search_es`,
// `case_search/const.py::CASE_SEARCH_MAX_RESULTS`). The snapshot is that read
// without a page window: every match up to the cap, and how many matched.

import { type Kysely, sql } from "kysely";
import { beforeEach, describe, expect, it } from "vitest";
import { buildDoc, caseListConfig } from "@/lib/__tests__/docHelpers";
import { buildCaseTypeMap, type CaseStore } from "@/lib/case-store";
import { PostgresCaseStore } from "@/lib/case-store/postgres/store";
import { HeuristicCaseGenerator } from "@/lib/case-store/sample/heuristic";
import { setupPerTestDatabase } from "@/lib/case-store/sql/__tests__/perTestDatabase";
import type { Database } from "@/lib/case-store/sql/database";
import { SEARCH_RESULTS_CAP } from "@/lib/commcare/session";
import type { CaseType } from "@/lib/domain";
import { SEARCH_READING } from "@/lib/domain/expression/temporalType";
import { proseText } from "@/lib/domain/prose";
import { assertAdmittedPreviewDoc } from "../../__tests__/fixtures/admittedDoc";
import { readSearchResultsSnapshot } from "../searchResultsSnapshot";

const APP_ID = "app-search-results";
const PROJECT = "project-search-results";
const WORKER = "worker-searching";
const OTHER_WORKER = "worker-other";
const EXCLUDED_WORKER = "worker-excluded";

const HOUSEHOLD: CaseType = {
	name: "household",
	properties: [{ name: "village", label: proseText("Village") }],
};
const PATIENT: CaseType = {
	name: "patient",
	parent_type: "household",
	properties: [{ name: "district", label: proseText("District") }],
};

const dbHandle = setupPerTestDatabase({
	schema: "migrated",
	databaseNamePrefix: "search_results_",
});

function storeAs(ownerId: string): CaseStore {
	return new PostgresCaseStore({
		projectId: PROJECT,
		actorUserId: WORKER,
		ownerId,
		db: dbHandle.db as unknown as Kysely<Database>,
		sampleGenerator: new HeuristicCaseGenerator(),
	});
}

function patient(caseId: string, status = "open", parent?: string) {
	return {
		appId: APP_ID,
		row: {
			case_id: caseId,
			case_type: "patient",
			case_name: caseId,
			status,
			properties: { district: "north" },
			...(parent === undefined ? {} : { parent_case_id: parent }),
		},
	};
}

beforeEach(async () => {
	await sql`
		INSERT INTO apps (id, owner, project_id, app_name, app_name_lower)
		VALUES (${APP_ID}, ${WORKER}, ${PROJECT}, 'Search results', 'search results')
	`.execute(dbHandle.db);
	const doc = assertAdmittedPreviewDoc(
		buildDoc({
			appId: APP_ID,
			caseTypes: [HOUSEHOLD, PATIENT],
			modules: [HOUSEHOLD, PATIENT].map((type) => ({
				name: type.name,
				caseType: type.name,
				caseListOnly: true,
				caseListConfig: caseListConfig([
					{ field: "case_name", header: "Name" },
				]),
				forms: [],
			})),
		}),
	);
	const mine = storeAs(WORKER);
	for (const type of [HOUSEHOLD, PATIENT])
		await mine.applySchemaChange({
			appId: APP_ID,
			caseType: type.name,
			caseTypeSchemas: buildCaseTypeMap(doc),
		});
});

const SEARCH = {
	appId: APP_ID,
	caseType: "patient",
	reading: SEARCH_READING,
	searchPopulation: { heldBy: { ownerIds: [WORKER] } },
} as const;

describe("a completed search's snapshot", () => {
	it("holds every open match, past one page, and none closed", async () => {
		const mine = storeAs(WORKER);
		for (let index = 0; index < 60; index += 1)
			await mine.insert(patient(`p-${String(index).padStart(3, "0")}`));
		await mine.insert(patient("p-closed", "closed"));

		const snapshot = await readSearchResultsSnapshot(mine, SEARCH);
		expect(snapshot.rows).toHaveLength(60);
		expect(snapshot.totalMatches).toBe(60);
		expect(snapshot.rows.some((row) => row.case_id === "p-closed")).toBe(false);
	});

	// One insert statement and one read, inside the default five seconds: the
	// test above, sixty-one store writes and a read, takes under one in CI.
	// Writing the cap's 503 rows through the store, one validated transaction
	// each, took fourteen. This test is about the read's cap, not how a row is
	// written, so the rows go straight to the table.
	it("stops at the cap and counts every match", async () => {
		const opened = new Date("2026-05-02T12:00:00Z");
		await (dbHandle.db as unknown as Kysely<Database>)
			.insertInto("cases")
			.values(
				Array.from({ length: SEARCH_RESULTS_CAP + 3 }, (_, index) => {
					const caseId = `p-${String(index).padStart(4, "0")}`;
					return {
						case_id: caseId,
						case_name: caseId,
						case_type: "patient",
						app_id: APP_ID,
						project_id: PROJECT,
						owner_id: WORKER,
						status: "open",
						opened_on: opened,
						modified_on: opened,
						properties: JSON.stringify({ district: "north" }),
					};
				}),
			)
			.execute();

		const snapshot = await readSearchResultsSnapshot(storeAs(WORKER), SEARCH);
		expect(snapshot.rows).toHaveLength(SEARCH_RESULTS_CAP);
		expect(snapshot.totalMatches).toBe(SEARCH_RESULTS_CAP + 3);
	});

	it("holds a case outside the worker's restore and drops an excluded owner's", async () => {
		await storeAs(WORKER).insert(patient("p-mine"));
		await storeAs(OTHER_WORKER).insert(patient("p-theirs"));
		await storeAs(EXCLUDED_WORKER).insert(patient("p-excluded"));

		const snapshot = await readSearchResultsSnapshot(storeAs(WORKER), {
			...SEARCH,
			excludedOwnerIds: [EXCLUDED_WORKER],
		});
		expect(snapshot.rows.map((row) => row.case_id).sort()).toEqual([
			"p-mine",
			"p-theirs",
		]);
		expect(snapshot.totalMatches).toBe(2);
	});

	it("carries each case's direct indices and its dates as plain text", async () => {
		const mine = storeAs(WORKER);
		await mine.insert({
			appId: APP_ID,
			row: {
				case_id: "h-1",
				case_type: "household",
				case_name: "Household",
				status: "open",
				properties: {},
			},
		});
		await mine.insert(patient("p-child", "open", "h-1"));

		const snapshot = await readSearchResultsSnapshot(mine, SEARCH);
		const [row] = snapshot.rows;
		expect(row?.indices).toEqual([
			{
				identifier: "parent",
				ancestor_id: "h-1",
				target_case_type: "household",
				relationship: "child",
			},
		]);
		// Plain JSON, as every case-data Server Action's result is.
		expect(typeof row?.opened_on).toBe("string");
		expect(JSON.parse(JSON.stringify(snapshot))).toEqual(snapshot);
	});

	it("is empty for a search that finds nothing", async () => {
		const snapshot = await readSearchResultsSnapshot(storeAs(WORKER), SEARCH);
		expect(snapshot).toEqual({ rows: [], totalMatches: 0 });
	});
});
