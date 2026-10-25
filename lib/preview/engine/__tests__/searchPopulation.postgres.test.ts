// lib/preview/engine/__tests__/searchPopulation.postgres.test.ts
//
// What a running read reads, against real Postgres through the reads the
// Server Actions call (`readCases`, `readCaseData`, `readCaseDatabaseSnapshot`).
//
// A search reads HQ's search population, the Project's open cases of the type
// (`case_search/utils.py::CaseSearchQueryBuilder._get_initial_search_es`), and
// says of each row whether the searching worker's device holds it. A browse
// list reads the worker's restore, and the restore holds the worker's claims.

import { type Kysely, sql } from "kysely";
import { beforeEach, describe, expect, it } from "vitest";
import { buildDoc, caseListConfig } from "@/lib/__tests__/docHelpers";
import { buildCaseTypeMap, type CaseStore } from "@/lib/case-store";
import { PostgresCaseStore } from "@/lib/case-store/postgres/store";
import { HeuristicCaseGenerator } from "@/lib/case-store/sample/heuristic";
import { setupPerTestDatabase } from "@/lib/case-store/sql/__tests__/perTestDatabase";
import type { Database } from "@/lib/case-store/sql/database";
import type { CaseType } from "@/lib/domain";
import {
	CASEDB_READING,
	SEARCH_READING,
} from "@/lib/domain/expression/temporalType";
import { proseText } from "@/lib/domain/prose";
import { assertAdmittedPreviewDoc } from "../../__tests__/fixtures/admittedDoc";
import {
	readCaseData,
	readCaseDatabaseSnapshot,
	readCases,
} from "../caseDataBindingHelpers";

const APP_ID = "app-search-population";
const PROJECT = "project-search-population";
const WORKER = "worker-searching";
const OTHER_WORKER = "worker-other";

const MINE = "50000000-0000-0000-0000-000000000001";
const THEIRS = "50000000-0000-0000-0000-000000000002";
const CLOSED = "50000000-0000-0000-0000-000000000003";
const THEIR_VISIT = "50000000-0000-0000-0000-000000000004";

const PATIENT: CaseType = {
	name: "patient",
	properties: [{ name: "age", label: proseText("Age"), data_type: "int" }],
};
const VISIT: CaseType = {
	name: "visit",
	parent_type: "patient",
	relationship: "extension",
	properties: [{ name: "notes", label: proseText("Notes"), data_type: "text" }],
};

const dbHandle = setupPerTestDatabase({
	schema: "migrated",
	databaseNamePrefix: "search_population_",
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

beforeEach(async () => {
	await sql`
		INSERT INTO apps (id, owner, project_id, app_name, app_name_lower)
		VALUES (${APP_ID}, ${WORKER}, ${PROJECT}, 'Search population', 'search population')
	`.execute(dbHandle.db);
	const doc = assertAdmittedPreviewDoc(
		buildDoc({
			appId: APP_ID,
			caseTypes: [PATIENT, VISIT],
			modules: [PATIENT, VISIT].map((type) => ({
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
	for (const type of [PATIENT, VISIT])
		await mine.applySchemaChange({
			appId: APP_ID,
			caseType: type.name,
			caseTypeSchemas: buildCaseTypeMap(doc),
		});
	const row = (caseId: string, caseName: string, status = "open") => ({
		appId: APP_ID,
		row: {
			case_id: caseId,
			case_type: "patient",
			case_name: caseName,
			status,
			properties: {},
		},
	});
	await mine.insert(row(MINE, "Mine"));
	const theirs = storeAs(OTHER_WORKER);
	await theirs.insert(row(THEIRS, "Theirs"));
	await theirs.insert(row(CLOSED, "Closed", "closed"));
	await theirs.insert({
		appId: APP_ID,
		row: {
			case_id: THEIR_VISIT,
			case_type: "visit",
			case_name: "Their visit",
			status: "open",
			parent_case_id: THEIRS,
			properties: {},
		},
		parentRelationship: "extension",
	});
});

const OWNED = { ownerIds: [WORKER] } as const;
const OWNED_AND_CLAIMED = { ownerIds: [WORKER], claimedCaseIds: [THEIRS] };

function heldById(
	rows: readonly { case_id: string; heldOnDevice?: boolean }[],
) {
	return Object.fromEntries(rows.map((row) => [row.case_id, row.heldOnDevice]));
}

describe("a search's population", () => {
	it("reads the Project's open cases past the restore and says which the device holds", async () => {
		const result = await readCases(storeAs(WORKER), {
			tileGrouping: "grouped",
			appId: APP_ID,
			caseType: "patient",
			reading: SEARCH_READING,
			page: { offset: 0, limit: 10 },
			searchPopulation: { heldBy: OWNED },
		});
		if (result.kind !== "rows")
			throw new Error(`expected rows, got ${result.kind}`);
		// A case another worker owns is found; a closed one is not.
		expect(heldById(result.rows)).toEqual({ [MINE]: true, [THEIRS]: false });
		// HQ's search is not a restore, so Results say nothing is left out.
		expect(result.outsideRestoreCount).toBeUndefined();
		expect(result.totalCount).toBe(2);
	});

	it("reads a claimed case as one the device holds", async () => {
		const result = await readCases(storeAs(WORKER), {
			tileGrouping: "grouped",
			appId: APP_ID,
			caseType: "patient",
			reading: SEARCH_READING,
			page: { offset: 0, limit: 10 },
			searchPopulation: { heldBy: OWNED_AND_CLAIMED },
		});
		if (result.kind !== "rows")
			throw new Error(`expected rows, got ${result.kind}`);
		expect(heldById(result.rows)).toEqual({ [MINE]: true, [THEIRS]: true });
	});

	it("checks a several-case selection against the same population", async () => {
		const result = await readCases(storeAs(WORKER), {
			tileGrouping: "grouped",
			appId: APP_ID,
			caseType: "patient",
			reading: CASEDB_READING,
			caseIds: [THEIRS, CLOSED],
			searchPopulation: { heldBy: OWNED },
		});
		if (result.kind !== "rows")
			throw new Error(`expected rows, got ${result.kind}`);
		expect(result.rows.map((row) => row.case_id)).toEqual([THEIRS]);
	});

	it("opens Details of a searched case another worker owns", async () => {
		const searched = await readCaseData(storeAs(WORKER), {
			appId: APP_ID,
			caseType: "patient",
			caseId: THEIRS,
			reading: SEARCH_READING,
			ancestorDepth: 0,
			searchPopulation: { heldBy: OWNED },
		});
		expect(searched).toMatchObject({
			kind: "row",
			row: { case_id: THEIRS, heldOnDevice: false },
		});
		const onDevice = await readCaseData(storeAs(WORKER), {
			appId: APP_ID,
			caseType: "patient",
			caseId: THEIRS,
			reading: CASEDB_READING,
			ancestorDepth: 0,
			restoreScope: OWNED,
		});
		expect(onDevice).toEqual({ kind: "missing" });
	});
});

describe("a browse list and the device", () => {
	it("reads the restore and counts what it leaves out", async () => {
		const result = await readCases(storeAs(WORKER), {
			tileGrouping: "grouped",
			appId: APP_ID,
			caseType: "patient",
			reading: CASEDB_READING,
			page: { offset: 0, limit: 10 },
			restoreScope: OWNED,
		});
		if (result.kind !== "rows")
			throw new Error(`expected rows, got ${result.kind}`);
		expect(result.rows.map((row) => row.case_id)).toEqual([MINE]);
		expect(result.rows[0]?.heldOnDevice).toBeUndefined();
		expect(result.outsideRestoreCount).toBeGreaterThan(0);
	});

	it("holds a claimed case in the list, the preload and the device snapshot", async () => {
		const list = await readCases(storeAs(WORKER), {
			tileGrouping: "grouped",
			appId: APP_ID,
			caseType: "patient",
			reading: CASEDB_READING,
			page: { offset: 0, limit: 10 },
			restoreScope: OWNED_AND_CLAIMED,
		});
		if (list.kind !== "rows")
			throw new Error(`expected rows, got ${list.kind}`);
		expect(list.rows.map((row) => row.case_id).sort()).toEqual([MINE, THEIRS]);
		expect(
			await readCaseData(storeAs(WORKER), {
				appId: APP_ID,
				caseType: "patient",
				caseId: THEIRS,
				reading: CASEDB_READING,
				ancestorDepth: 0,
				restoreScope: OWNED_AND_CLAIMED,
			}),
		).toMatchObject({ kind: "row", row: { case_id: THEIRS } });
		const snapshot = await readCaseDatabaseSnapshot(storeAs(WORKER), {
			appId: APP_ID,
			restoreScope: OWNED_AND_CLAIMED,
		});
		// The claimed case is live, so its open extension comes with it, as
		// it would through HQ's claim.
		expect(snapshot.rows.map((row) => row.case_id).sort()).toEqual(
			[MINE, THEIRS, THEIR_VISIT].sort(),
		);
		expect(snapshot.indices).toContainEqual(
			expect.objectContaining({ case_id: THEIR_VISIT, ancestor_id: THEIRS }),
		);
		const unclaimed = await readCaseDatabaseSnapshot(storeAs(WORKER), {
			appId: APP_ID,
			restoreScope: OWNED,
		});
		expect(unclaimed.rows.map((row) => row.case_id)).toEqual([MINE]);
	});
});
