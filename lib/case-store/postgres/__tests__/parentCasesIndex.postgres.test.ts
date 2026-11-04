// lib/case-store/postgres/__tests__/parentCasesIndex.postgres.test.ts
//
// The selected-parent constraint's two readings, on real Postgres. A menu
// beneath a parent list reads its children the way the wire's datum filter
// does: a basic menu through any non-extension index
// (`corehq/apps/app_manager/suite_xml/sections/entries.py::EntriesHelper.get_parent_filter`,
// `[index/*[not(@relationship='extension')]=<parent>]`), a menu that names the
// index through that one identifier whatever its relationship
// (`::EntriesHelper.get_parent_filter_by_ref_id`, `[index/<reference_id>=<parent>]`).
// The store compiles both into the list's own statement, so the rows and the
// count come from the same SQL.

import type { Kysely } from "kysely";
import { beforeEach, describe, expect, it } from "vitest";
import type { CaseType } from "@/lib/domain";
import { SEARCH_READING } from "@/lib/domain/expression/temporalType";
import { buildSimpleBlueprint } from "../../__tests__/fixtures/simpleBlueprint";
import { HeuristicCaseGenerator } from "../../sample/heuristic";
import { setupPerTestDatabase } from "../../sql/__tests__/perTestDatabase";
import type { Database } from "../../sql/database";
import { buildCaseTypeMap, type SelectedParentCases } from "../../store";
import { PostgresCaseStore } from "../store";

const APP_ID = "app-parent-index";
const PROJECT_ID = "project-parent-index";

const dbHandle = setupPerTestDatabase({
	schema: "migrated",
	databaseNamePrefix: "parent_index_test_",
});

beforeEach(async () => {
	await dbHandle.pool.query(
		`INSERT INTO apps (id, owner, project_id, app_name, app_name_lower)
		 VALUES ($1, $2, $2, 'Parent index', 'parent index')`,
		[APP_ID, PROJECT_ID],
	);
});

function database(): Kysely<Database> {
	return dbHandle.db as unknown as Kysely<Database>;
}

function makeStore(): PostgresCaseStore {
	return new PostgresCaseStore({
		projectId: PROJECT_ID,
		actorUserId: PROJECT_ID,
		ownerId: PROJECT_ID,
		db: database(),
		sampleGenerator: new HeuristicCaseGenerator(),
	});
}

/**
 * One household with three `member` cases beneath it: one linked as a child
 * under `parent`, one linked as a child under `mother`, and one linked as an
 * extension under `parent`. A second household's child under `parent` proves
 * the constraint still reads only the selected parent.
 */
async function seedHousehold(store: PostgresCaseStore): Promise<void> {
	const caseTypes: CaseType[] = [
		{ name: "household", properties: [] },
		{ name: "member", parent_type: "household", properties: [] },
	];
	const caseTypeSchemas = buildCaseTypeMap(
		buildSimpleBlueprint(caseTypes, APP_ID),
	);
	for (const caseType of caseTypes) {
		await store.applySchemaChange({
			appId: APP_ID,
			caseType: caseType.name,
			caseTypeSchemas,
		});
	}
	for (const householdId of ["household-a", "household-b"]) {
		await store.insert({
			appId: APP_ID,
			row: {
				case_id: householdId,
				case_type: "household",
				case_name: householdId,
				properties: {},
			},
		});
	}
	for (const [caseId, parentCaseId, parentRelationship] of [
		["child-under-parent", "household-a", "child"],
		["extension-under-parent", "household-a", "extension"],
		["other-household-child", "household-b", "child"],
	] as const) {
		await store.insert({
			appId: APP_ID,
			parentRelationship,
			row: {
				case_id: caseId,
				case_type: "member",
				case_name: caseId,
				parent_case_id: parentCaseId,
				properties: {},
			},
		});
	}
	await store.insert({
		appId: APP_ID,
		row: {
			case_id: "child-under-mother",
			case_type: "member",
			case_name: "child-under-mother",
			properties: {},
		},
	});
	// The store's insert writes only the `parent` identifier; a submission's
	// case operation is what writes any other, so the edge is seeded directly.
	await database()
		.insertInto("case_indices")
		.values({
			case_id: "child-under-mother",
			ancestor_id: "household-a",
			target_case_type: "household",
			identifier: "mother",
			relationship: "child",
			depth: 1,
		})
		.execute();
}

async function listedMembers(
	store: PostgresCaseStore,
	parentCases: SelectedParentCases,
): Promise<{ rows: string[]; count: number }> {
	const rows = await store.query({
		reading: SEARCH_READING,
		appId: APP_ID,
		caseType: "member",
		parentCases,
	});
	const count = await store.count({
		reading: SEARCH_READING,
		appId: APP_ID,
		caseType: "member",
		parentCases,
	});
	return { rows: rows.map((row) => row.case_id).sort(), count };
}

describe("PostgresCaseStore selected-parent index", () => {
	it("reads any non-extension child when no index is named", async () => {
		const store = makeStore();
		await seedHousehold(store);

		expect(
			await listedMembers(store, {
				caseType: "household",
				caseIds: ["household-a"],
			}),
		).toEqual({
			rows: ["child-under-mother", "child-under-parent"],
			count: 2,
		});
	});

	it("reads the cases whose named index points at the parent, extensions included", async () => {
		const store = makeStore();
		await seedHousehold(store);

		expect(
			await listedMembers(store, {
				caseType: "household",
				caseIds: ["household-a"],
				index: "parent",
			}),
		).toEqual({
			rows: ["child-under-parent", "extension-under-parent"],
			count: 2,
		});
		expect(
			await listedMembers(store, {
				caseType: "household",
				caseIds: ["household-a"],
				index: "mother",
			}),
		).toEqual({ rows: ["child-under-mother"], count: 1 });
		expect(
			await listedMembers(store, {
				caseType: "household",
				caseIds: ["household-a", "household-b"],
				index: "parent",
			}),
		).toEqual({
			rows: [
				"child-under-parent",
				"extension-under-parent",
				"other-household-child",
			],
			count: 3,
		});
	});

	it("refuses a blank index identifier before any read", async () => {
		const store = makeStore();
		await seedHousehold(store);

		await expect(
			store.query({
				reading: SEARCH_READING,
				appId: APP_ID,
				caseType: "member",
				parentCases: {
					caseType: "household",
					caseIds: ["household-a"],
					index: " ",
				},
			}),
		).rejects.toThrow(/blank type, id or index identifier/);
	});
});
