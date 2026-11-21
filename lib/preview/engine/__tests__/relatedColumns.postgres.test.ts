// A case list column read through a relation shows, orders and filters by the
// related case's value, as a device reads it through the column's casedb join.
// Preview's Results read goes through the order plan and the case store
// (`readCases`), which projects each related value beside the row under its
// column's uuid and orders by the same walk. A member with no household reads
// blank, which the rule places last.

import type { Kysely } from "kysely";
import { beforeEach, describe, expect, it } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import { buildDoc } from "@/lib/__tests__/docHelpers";
import { buildCaseTypeMap } from "@/lib/case-store";
import { PostgresCaseStore } from "@/lib/case-store/postgres/store";
import { HeuristicCaseGenerator } from "@/lib/case-store/sample/heuristic";
import { setupPerTestDatabase } from "@/lib/case-store/sql/__tests__/perTestDatabase";
import type { Database } from "@/lib/case-store/sql/database";
import {
	type BlueprintDoc,
	type CaseListConfig,
	type Column,
	columnSort,
	plainColumn,
	proseText,
} from "@/lib/domain";
import { CASEDB_READING } from "@/lib/domain/expression/temporalType";
import { readCases } from "../caseDataBindingHelpers";
import { previewCaseStoreOrder } from "../caseListOrder";

const APP_ID = "app-related-columns";
const PROJECT_ID = "project-related-columns";
const NAME = testUuid("related-columns-name");
const HOUSEHOLD = testUuid("related-columns-household");

const dbHandle = setupPerTestDatabase({
	schema: "migrated",
	databaseNamePrefix: "related_columns_",
});

beforeEach(async () => {
	await dbHandle.pool.query(`
		INSERT INTO apps (id, owner, project_id, app_name, app_name_lower)
		VALUES ('${APP_ID}', 'owner-a', '${PROJECT_ID}', 'Related', 'related')
	`);
});

function makeStore(): PostgresCaseStore {
	return new PostgresCaseStore({
		projectId: PROJECT_ID,
		actorUserId: "owner-a",
		ownerId: "owner-a",
		db: dbHandle.db as unknown as Kysely<Database>,
		sampleGenerator: new HeuristicCaseGenerator(),
	});
}

/** Members under households; the Members list shows each member's name and
 *  its household's address, ordered by the address. */
function membersDoc(): { doc: BlueprintDoc; config: CaseListConfig } {
	const columns: Column[] = [
		plainColumn(NAME, "case_name", "Name"),
		plainColumn(HOUSEHOLD, "address", "Address", {
			via: [{ identifier: "parent" }],
			sort: columnSort("asc", 0, "last"),
		}),
	];
	const config: CaseListConfig = {
		columns,
		searchInputs: [],
		listColumnOrder: columns.map((column) => column.uuid),
		detailColumnOrder: columns.map((column) => column.uuid),
	};
	const doc = buildDoc({
		appId: APP_ID,
		appName: "Related",
		caseTypes: [
			{
				name: "household",
				properties: [{ name: "address", label: proseText("Address") }],
			},
			{ name: "member", parent_type: "household", properties: [] },
		],
		modules: [
			{
				name: "Members",
				caseType: "member",
				caseListMenuItem: {},
				caseListConfig: config,
			},
		],
	});
	return { doc, config };
}

async function seed(store: PostgresCaseStore, doc: BlueprintDoc) {
	for (const caseType of ["household", "member"])
		await store.applySchemaChange({
			appId: APP_ID,
			caseType,
			caseTypeSchemas: buildCaseTypeMap(doc),
		});
	for (const [caseId, address] of [
		["house-b", "Birch Road"],
		["house-a", "Alder Lane"],
	] as const)
		await store.insert({
			appId: APP_ID,
			row: {
				case_id: caseId,
				case_type: "household",
				case_name: caseId,
				status: "open",
				properties: { address },
			},
		});
	for (const [caseId, parent] of [
		["member-1", "house-b"],
		["member-2", "house-a"],
		["member-3", undefined],
	] as const)
		await store.insert({
			appId: APP_ID,
			row: {
				case_id: caseId,
				case_type: "member",
				case_name: caseId,
				status: "open",
				properties: {},
				...(parent !== undefined && { parent_case_id: parent }),
			},
		});
}

async function previewRows(store: PostgresCaseStore, doc: BlueprintDoc) {
	const { config } = membersDoc();
	const mod = Object.values(doc.modules)[0];
	if (mod?.caseType === undefined) throw new Error("Expected the module.");
	const result = await readCases(store, {
		reading: CASEDB_READING,
		tileGrouping: "flat",
		appId: APP_ID,
		caseType: "member",
		caseTypeSchemas: buildCaseTypeMap(doc),
		caseListConfig: config,
		order: previewCaseStoreOrder(
			{ ...mod, caseType: mod.caseType },
			doc,
			config,
			"eng",
		),
	});
	if (result.kind !== "rows")
		throw new Error(`Expected rows, got ${result.kind}.`);
	return result.rows;
}

describe("a column read through the parent, in Preview's Results read", () => {
	it("shows each member's household address and orders by it, a member with none last", async () => {
		const { doc } = membersDoc();
		const store = makeStore();
		await seed(store, doc);
		const rows = await previewRows(store, doc);
		expect(
			rows.map((row) => [row.case_id, row.calculated[HOUSEHOLD] ?? null]),
		).toEqual([
			["member-2", "Alder Lane"],
			["member-1", "Birch Road"],
			["member-3", null],
		]);
	});
});
