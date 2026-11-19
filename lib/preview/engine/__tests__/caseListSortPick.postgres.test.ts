// A pick in the list's Sort by orders the rows in the case store, through the
// same read the running list makes (`readCases` over `previewCaseStoreOrder`),
// so every page follows it. Android breaks the pick's ties by the order the
// list held before it; Web Apps sorts by the pick alone, and Preview breaks
// its ties by case id.

import type { Kysely } from "kysely";
import { beforeEach, describe, expect, it } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import { rowsMatchingFilterText } from "@/components/preview/shared/listFilter";
import { buildDoc } from "@/lib/__tests__/docHelpers";
import { buildCaseTypeMap } from "@/lib/case-store";
import { PostgresCaseStore } from "@/lib/case-store/postgres/store";
import { HeuristicCaseGenerator } from "@/lib/case-store/sample/heuristic";
import { setupPerTestDatabase } from "@/lib/case-store/sql/__tests__/perTestDatabase";
import type { Database } from "@/lib/case-store/sql/database";
import {
	type BlueprintDoc,
	type CaseListConfig,
	columnSort,
	plainColumn,
	proseText,
} from "@/lib/domain";
import { CASEDB_READING } from "@/lib/domain/expression/temporalType";
import { projectProseTemplate } from "@/lib/domain/prose";
import {
	type CaseListSortChoice,
	LIST_ORDER,
	pickCaseListSort,
} from "../../caseListSortMenu";
import type { ColumnDisplayContext } from "../../columnDisplay";
import { previewPlatformRules } from "../../platform";
import { readCases } from "../caseDataBindingHelpers";
import type { CaseRowWithCalculated } from "../caseDataBindingTypes";
import {
	previewCaseListOrderPlan,
	previewCaseStoreOrder,
} from "../caseListOrder";

const APP_ID = "app-case-list-sort-pick";
const PROJECT_ID = "project-case-list-sort-pick";
const CASE_TYPE = "member";

const dbHandle = setupPerTestDatabase({
	schema: "migrated",
	databaseNamePrefix: "case_list_sort_pick_",
});

beforeEach(async () => {
	await dbHandle.pool.query(`
		INSERT INTO apps (id, owner, project_id, app_name, app_name_lower)
		VALUES ('${APP_ID}', 'owner-a', '${PROJECT_ID}', 'Sort', 'sort')
	`);
});

const NAME = testUuid("sort-pick-name");
const VILLAGE = testUuid("sort-pick-village");
const AGE = testUuid("sort-pick-age");

/** Members listed by name, then village, with age hidden and sorted
 *  descending under a name in Sort by. */
function listDoc(): { doc: BlueprintDoc; config: CaseListConfig } {
	const columns = [
		plainColumn(NAME, "case_name", "Name", { sort: columnSort("asc", 1) }),
		plainColumn(VILLAGE, "village", "Village"),
		plainColumn(AGE, "age", "Age", {
			visibleInList: false,
			sort: columnSort("desc", 0, undefined, "Age"),
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
		appName: "Sort",
		modules: [
			{
				name: "Members",
				caseType: CASE_TYPE,
				caseListMenuItem: {},
				caseListConfig: config,
			},
		],
		caseTypes: [
			{
				name: CASE_TYPE,
				properties: [
					{ name: "case_name", label: proseText("Name") },
					{ name: "village", label: proseText("Village") },
					{ name: "age", label: proseText("Age"), data_type: "int" },
				],
			},
		],
	});
	return { doc, config };
}

/** Name, village, age. */
const MEMBERS: Record<string, readonly [string, string, string | undefined]> = {
	"m-1": ["Bea", "Hilltop", "30"],
	"m-2": ["Ana", "Riverside", "9"],
	"m-3": ["Cy", "Hilltop", undefined],
	"m-4": ["Dee", "Riverside", "30"],
	"m-5": ["Eli", "", "41"],
};

async function seededStore(
	doc: BlueprintDoc,
	members: Record<
		string,
		readonly [string, string, string | undefined]
	> = MEMBERS,
): Promise<PostgresCaseStore> {
	const store = new PostgresCaseStore({
		projectId: PROJECT_ID,
		actorUserId: "owner-a",
		ownerId: "owner-a",
		db: dbHandle.db as unknown as Kysely<Database>,
		sampleGenerator: new HeuristicCaseGenerator(),
	});
	await store.applySchemaChange({
		appId: APP_ID,
		caseType: CASE_TYPE,
		caseTypeSchemas: buildCaseTypeMap(doc),
	});
	for (const [caseId, [name, village, age]] of Object.entries(members))
		await store.insert({
			appId: APP_ID,
			row: {
				case_id: caseId,
				case_type: CASE_TYPE,
				case_name: name,
				status: "open",
				properties: {
					...(village !== "" && { village }),
					...(age !== undefined && { age: Number(age) }),
				},
			},
		});
	return store;
}

async function listed(
	store: PostgresCaseStore,
	doc: BlueprintDoc,
	config: CaseListConfig,
	choice: CaseListSortChoice,
	page?: { offset: number; limit: number },
): Promise<string[]> {
	return (await listedRows(store, doc, config, choice, page)).map(
		(row) => row.case_id,
	);
}

async function listedRows(
	store: PostgresCaseStore,
	doc: BlueprintDoc,
	config: CaseListConfig,
	choice: CaseListSortChoice,
	page?: { offset: number; limit: number },
): Promise<readonly CaseRowWithCalculated[]> {
	const mod = Object.values(doc.modules)[0];
	if (mod?.caseType === undefined) throw new Error("Expected the module.");
	const result = await readCases(store, {
		reading: CASEDB_READING,
		tileGrouping: "flat",
		appId: APP_ID,
		caseType: CASE_TYPE,
		caseTypeSchemas: buildCaseTypeMap(doc),
		caseListConfig: config,
		order: previewCaseStoreOrder(
			{ ...mod, caseType: mod.caseType },
			doc,
			config,
			"eng",
			choice,
		),
		...(page !== undefined && { page }),
	});
	if (result.kind !== "rows")
		throw new Error(`Expected rows, got ${result.kind}.`);
	return result.rows;
}

function picks(
	doc: BlueprintDoc,
	config: CaseListConfig,
	platform: "android" | "web-apps",
	columns: readonly string[],
): CaseListSortChoice {
	const mod = Object.values(doc.modules)[0];
	if (mod === undefined) throw new Error("Expected the module.");
	const plan = previewCaseListOrderPlan(mod, doc, config);
	return columns.reduce(
		(choice, column) =>
			pickCaseListSort(
				choice,
				column,
				plan,
				config.columns,
				previewPlatformRules(platform).sortMenu,
			),
		LIST_ORDER,
	);
}

describe("a pick in the list's Sort by orders the rows in the case store", () => {
	it("keeps the list's own order with no pick: age descending, blanks last, then name", async () => {
		const { doc, config } = listDoc();
		const store = await seededStore(doc);
		expect(await listed(store, doc, config, LIST_ORDER)).toEqual([
			"m-5",
			"m-1",
			"m-4",
			"m-2",
			"m-3",
		]);
	});

	it("orders by an unsorted shown field alone on Web Apps, blanks first, ties by case id", async () => {
		const { doc, config } = listDoc();
		const store = await seededStore(doc);
		// Web Apps lists only sort fields, but the store orders whatever the
		// choice names; village has no `<sort>`, so it is ascending text with
		// blanks first.
		const choice: CaseListSortChoice = {
			picks: [{ column: VILLAGE, reversed: false }],
			thenListOrder: false,
		};
		expect(await listed(store, doc, config, choice)).toEqual([
			"m-5",
			"m-1",
			"m-3",
			"m-2",
			"m-4",
		]);
	});

	it("breaks a pick's ties on Android by the order the list held before it", async () => {
		const { doc, config } = listDoc();
		const store = await seededStore(doc);
		// Village, ties by the list's own order: Hilltop holds m-1 (30) before
		// m-3 (no age); Riverside m-4 (30) before m-2 (9).
		expect(
			await listed(
				store,
				doc,
				config,
				picks(doc, config, "android", [VILLAGE]),
			),
		).toEqual(["m-5", "m-1", "m-3", "m-4", "m-2"]);
		// Then name: the earlier village pick no longer decides anything.
		expect(
			await listed(
				store,
				doc,
				config,
				picks(doc, config, "android", [VILLAGE, NAME]),
			),
		).toEqual(["m-2", "m-1", "m-3", "m-4", "m-5"]);
	});

	it("turns a hidden field around when picked again, keeping its blanks last", async () => {
		const { doc, config } = listDoc();
		const store = await seededStore(doc);
		const once = picks(doc, config, "web-apps", [AGE]);
		expect(once.picks).toEqual([{ column: AGE, reversed: false }]);
		expect(await listed(store, doc, config, once)).toEqual([
			"m-5",
			"m-1",
			"m-4",
			"m-2",
			"m-3",
		]);
		const twice = picks(doc, config, "web-apps", [AGE, AGE]);
		expect(twice.picks).toEqual([{ column: AGE, reversed: true }]);
		// Ascending now, an integer comparison, and the blank stays last
		// whatever the direction (commcare-core `EntitySorter.getCmp`).
		expect(await listed(store, doc, config, twice)).toEqual([
			"m-2",
			"m-1",
			"m-4",
			"m-5",
			"m-3",
		]);
	});

	it("orders every page by the pick", async () => {
		const { doc, config } = listDoc();
		const store = await seededStore(doc);
		const choice = picks(doc, config, "web-apps", [NAME, NAME]);
		const first = await listed(store, doc, config, choice, {
			offset: 0,
			limit: 2,
		});
		const second = await listed(store, doc, config, choice, {
			offset: 2,
			limit: 2,
		});
		const third = await listed(store, doc, config, choice, {
			offset: 4,
			limit: 2,
		});
		expect([...first, ...second, ...third]).toEqual([
			"m-5",
			"m-4",
			"m-3",
			"m-1",
			"m-2",
		]);
	});

	it("orders nothing by a pick the list no longer holds", async () => {
		const { doc, config } = listDoc();
		const store = await seededStore(doc);
		const stale: CaseListSortChoice = {
			picks: [{ column: testUuid("sort-pick-gone"), reversed: true }],
			thenListOrder: false,
		};
		expect(await listed(store, doc, config, stale)).toEqual([
			"m-5",
			"m-1",
			"m-4",
			"m-2",
			"m-3",
		]);
	});
});

describe("a pick and the filter's closeness on Web Apps with fuzzy search", () => {
	// Formplayer filters the list, closest matches first, then sorts the
	// matches again with a stable sort by the order it shows
	// (`EntityScreenHelper.initEntities`: `filterEntities`, `sortEntities`):
	// by the pick alone where there is one. So the matches the pick ties keep
	// their closeness, whatever the list's own rules say of them.
	const NEAR: Record<string, readonly [string, string, string | undefined]> = {
		// The pick (village) ties the two; the list's own order (age
		// descending) holds them apart. Case ids put the farther first.
		"t-1": ["Anay", "Hilltop", "40"],
		"t-2": ["Anaya", "Hilltop", "20"],
	};
	const DISPLAY: ColumnDisplayContext = {
		calculatedTemporalTypes: new Map(),
		caseProperties: [],
		today: new Date("2026-05-06T12:00:00Z"),
		projectProse: (template) =>
			projectProseTemplate(template, { fields: {}, forms: {}, fieldOrder: {} })
				.text,
	};

	async function shown(choice: CaseListSortChoice): Promise<string[]> {
		const { doc, config } = listDoc();
		const store = await seededStore(doc, NEAR);
		const mod = Object.values(doc.modules)[0];
		if (mod === undefined) throw new Error("Expected the module.");
		const rows = await listedRows(store, doc, config, choice);
		return rowsMatchingFilterText(
			config.columns.filter((column) => column.visibleInList !== false),
			rows,
			"anaya",
			DISPLAY,
			previewCaseListOrderPlan(mod, doc, config),
			{
				fuzzy: true,
				rules: previewPlatformRules("web-apps").listFilter,
				edited: true,
				imageReference: () => undefined,
				sortChoice: choice,
			},
		).map((row) => row.case_id);
	}

	it("keeps the list's order where its rules hold the matches apart", async () => {
		expect(await shown(LIST_ORDER)).toEqual(["t-1", "t-2"]);
	});

	it("puts the closer match first where the pick ties them", async () => {
		const choice: CaseListSortChoice = {
			picks: [{ column: VILLAGE, reversed: false }],
			thenListOrder: false,
		};
		expect(await shown(choice)).toEqual(["t-2", "t-1"]);
	});
});
