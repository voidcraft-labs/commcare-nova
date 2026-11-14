// Preview orders a case list as a device does. The rows and orders are the
// checked-in control `proof/native/core/resources/case-list-order/orders.json`,
// which the lane's `CaseListOrderRuntimeTest` holds to Core's own
// `EntitySorter`: for each comparator, direction and blanks placement it
// lists the order Core gives the rows, a group being rows Core holds equal.
// Here the case store sorts the same rows by the same key, and each group
// must come in its place, in case id order within it (Preview's tie-break).

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Kysely, PostgresDialect } from "kysely";
import { Pool } from "pg";
import { beforeEach, describe, expect, it } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import { buildDoc } from "@/lib/__tests__/docHelpers";
import { buildCaseTypeMap, type SortKey } from "@/lib/case-store";
import { buildSimpleBlueprint } from "@/lib/case-store/__tests__/fixtures/simpleBlueprint";
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
	type SortBlanks,
	type SortDirection,
} from "@/lib/domain";
import { prop, term } from "@/lib/domain/expression";
import {
	CASEDB_READING,
	SEARCH_READING,
} from "@/lib/domain/expression/temporalType";
import { readCases } from "../caseDataBindingHelpers";
import { previewCaseStoreOrder } from "../caseListOrder";

interface ControlOrder {
	readonly comparator: "text" | "integer" | "decimal";
	readonly direction: "ascending" | "descending";
	readonly blanks: "first" | "last";
	readonly groups: readonly (readonly string[])[];
}

interface ControlSet {
	readonly name: string;
	readonly rows: readonly { readonly case: string; readonly value?: string }[];
	readonly orders: readonly ControlOrder[];
}

const CONTROL: { readonly sets: readonly ControlSet[] } = JSON.parse(
	readFileSync(
		join(
			process.cwd(),
			"proof/native/core/resources/case-list-order/orders.json",
		),
		"utf8",
	),
);

const APP_ID = "app-case-list-order";
const PROJECT_ID = "project-case-list-order";
const CASE_TYPE = "row";

const dbHandle = setupPerTestDatabase({
	schema: "migrated",
	databaseNamePrefix: "case_list_order_",
});

beforeEach(async () => {
	await dbHandle.pool.query(`
		INSERT INTO apps (id, owner, project_id, app_name, app_name_lower)
		VALUES ('${APP_ID}', 'owner-a', '${PROJECT_ID}', 'Order', 'order')
	`);
});

function makeStore(
	db: Kysely<Database> = dbHandle.db as unknown as Kysely<Database>,
): PostgresCaseStore {
	return new PostgresCaseStore({
		projectId: PROJECT_ID,
		actorUserId: "owner-a",
		ownerId: "owner-a",
		db,
		sampleGenerator: new HeuristicCaseGenerator(),
	});
}

// The stored value is text whatever comparator orders it: the comparator,
// not the property's declared type, decides what is a number.
const schemas = () =>
	buildCaseTypeMap(
		buildSimpleBlueprint(
			[
				{
					name: CASE_TYPE,
					properties: [{ name: "value", label: proseText("Value") }],
				},
			],
			APP_ID,
		),
	);

describe("the case store orders the control's rows as Core does", () => {
	for (const set of CONTROL.sets)
		for (const order of set.orders)
			it(`${set.name}: ${order.comparator}, ${order.direction}, blanks ${order.blanks}`, async () => {
				const store = makeStore();
				await store.applySchemaChange({
					appId: APP_ID,
					caseType: CASE_TYPE,
					caseTypeSchemas: schemas(),
				});
				for (const row of set.rows) {
					await store.insert({
						appId: APP_ID,
						row: {
							case_id: row.case,
							case_type: CASE_TYPE,
							case_name: row.case,
							status: "open",
							properties: row.value === undefined ? {} : { value: row.value },
						},
					});
				}
				const sort: SortKey[] = [
					{
						kind: "expression",
						expression: term(prop(CASE_TYPE, "value")),
						comparator: order.comparator,
						direction: order.direction === "ascending" ? "asc" : "desc",
						blanks: order.blanks,
					},
					{
						kind: "expression",
						expression: term(prop(CASE_TYPE, "case_id")),
						comparator: "text",
						direction: "asc",
						blanks: "first",
					},
				];
				const rows = await store.query({
					reading: SEARCH_READING,
					appId: APP_ID,
					caseType: CASE_TYPE,
					caseTypeSchemas: schemas(),
					sort,
				});
				expect(rows.map((row) => row.case_id)).toEqual(
					order.groups.flatMap((group) =>
						[...group].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)),
					),
				);
			});
});

describe("a multi select orders as a device reads it", () => {
	it("compares its tokens joined by one space, and an empty selection is blank", async () => {
		const store = makeStore();
		const multiSchemas = buildCaseTypeMap(
			buildSimpleBlueprint(
				[
					{
						name: CASE_TYPE,
						properties: [
							{
								name: "tags",
								label: proseText("Tags"),
								data_type: "multi_select",
								options: ["a", "b", "c"].map((value) => ({
									value,
									label: proseText(value),
								})),
							},
						],
					},
				],
				APP_ID,
			),
		);
		await store.applySchemaChange({
			appId: APP_ID,
			caseType: CASE_TYPE,
			caseTypeSchemas: multiSchemas,
		});
		const stored: Record<string, readonly string[] | undefined> = {
			"row-1": ["b"],
			"row-2": ["a", "c"],
			"row-3": [],
			"row-4": undefined,
			"row-5": ["a", "b"],
			"row-6": ["a"],
		};
		for (const [caseId, tags] of Object.entries(stored)) {
			await store.insert({
				appId: APP_ID,
				row: {
					case_id: caseId,
					case_type: CASE_TYPE,
					case_name: caseId,
					status: "open",
					properties: tags === undefined ? {} : { tags: [...tags] },
				},
			});
		}
		const rows = await store.query({
			reading: SEARCH_READING,
			appId: APP_ID,
			caseType: CASE_TYPE,
			caseTypeSchemas: multiSchemas,
			sort: [
				{
					kind: "expression",
					expression: term(prop(CASE_TYPE, "tags")),
					comparator: "text",
					direction: "asc",
					blanks: "first",
				},
				{
					kind: "expression",
					expression: term(prop(CASE_TYPE, "case_id")),
					comparator: "text",
					direction: "asc",
					blanks: "first",
				},
			],
		});
		// An empty selection and a missing one are blank; then "a" < "a b" <
		// "a c" < "b", which the stored arrays' JSON text does not give.
		expect(rows.map((row) => row.case_id)).toEqual([
			"row-3",
			"row-4",
			"row-6",
			"row-5",
			"row-2",
			"row-1",
		]);
	});
});

describe("an ID mapping orders as a device's selected() reads it", () => {
	it("finds an entry as one token among several, and never inside a token", async () => {
		const store = makeStore();
		await store.applySchemaChange({
			appId: APP_ID,
			caseType: CASE_TYPE,
			caseTypeSchemas: schemas(),
		});
		const stored: Record<string, string | undefined> = {
			"row-1": "b",
			"row-2": "c a",
			"row-3": "ab",
			"row-4": "",
			"row-5": undefined,
			"row-6": "c",
		};
		for (const [caseId, value] of Object.entries(stored)) {
			await store.insert({
				appId: APP_ID,
				row: {
					case_id: caseId,
					case_type: CASE_TYPE,
					case_name: caseId,
					status: "open",
					properties: value === undefined ? {} : { value },
				},
			});
		}
		const rows = await store.query({
			reading: SEARCH_READING,
			appId: APP_ID,
			caseType: CASE_TYPE,
			caseTypeSchemas: schemas(),
			sort: [
				{
					kind: "mapping-position",
					expression: term(prop(CASE_TYPE, "value")),
					values: ["a", "b"],
					direction: "asc",
					blanks: "last",
				},
				{
					kind: "expression",
					expression: term(prop(CASE_TYPE, "case_id")),
					comparator: "text",
					direction: "asc",
					blanks: "first",
				},
			],
		});
		// "c a" holds `a` as its second token (position 0), "b" is position 1;
		// "ab", "c", a blank and a missing value hold no entry and are blank.
		expect(rows.map((row) => row.case_id)).toEqual([
			"row-2",
			"row-1",
			"row-3",
			"row-4",
			"row-5",
			"row-6",
		]);
	});
});

const ORDERED = testUuid("case-list-order-ordered");
const NAME = testUuid("case-list-order-name");

/** One module listing `row` cases, ordered by its one ruled column over
 *  `property`, as Preview's Results read orders it: through the order plan
 *  (`previewCaseStoreOrder`) and `readCases`. */
function orderedListDoc(
	property: { readonly name: string; readonly data_type?: "datetime" },
	sort: ReturnType<typeof columnSort>,
): { doc: BlueprintDoc; config: CaseListConfig } {
	const columns = [
		plainColumn(NAME, "case_name", "Name"),
		plainColumn(ORDERED, property.name, "Ordered", { sort }),
	];
	const config: CaseListConfig = {
		columns,
		searchInputs: [],
		listColumnOrder: columns.map((column) => column.uuid),
		detailColumnOrder: columns.map((column) => column.uuid),
	};
	const doc = buildDoc({
		appId: APP_ID,
		appName: "Order",
		modules: [
			{
				name: "Rows",
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
					{
						name: property.name,
						label: proseText("Ordered"),
						...(property.data_type !== undefined && {
							data_type: property.data_type,
						}),
					},
				],
			},
		],
	});
	return { doc, config };
}

async function previewOrder(
	store: PostgresCaseStore,
	doc: BlueprintDoc,
	config: CaseListConfig,
): Promise<string[]> {
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
		),
	});
	if (result.kind !== "rows")
		throw new Error(`Expected rows, got ${result.kind}.`);
	return result.rows.map((row) => row.case_id);
}

describe("a rule's own blanks, through Preview's store read", () => {
	const VALUES: Record<string, string | undefined> = {
		"row-1": "b",
		"row-2": "",
		"row-3": undefined,
		"row-4": "a",
	};
	const cases: readonly [SortDirection, SortBlanks, readonly string[]][] = [
		["asc", "last", ["row-4", "row-1", "row-2", "row-3"]],
		["desc", "first", ["row-2", "row-3", "row-1", "row-4"]],
		["asc", "first", ["row-2", "row-3", "row-4", "row-1"]],
		["desc", "last", ["row-1", "row-4", "row-2", "row-3"]],
	];
	for (const [direction, blanks, expected] of cases)
		it(`${direction} with blanks ${blanks}`, async () => {
			const { doc, config } = orderedListDoc(
				{ name: "value" },
				columnSort(direction, 0, blanks),
			);
			const store = makeStore();
			await store.applySchemaChange({
				appId: APP_ID,
				caseType: CASE_TYPE,
				caseTypeSchemas: buildCaseTypeMap(doc),
			});
			for (const [caseId, value] of Object.entries(VALUES))
				await store.insert({
					appId: APP_ID,
					row: {
						case_id: caseId,
						case_type: CASE_TYPE,
						case_name: caseId,
						status: "open",
						properties: value === undefined ? {} : { value },
					},
				});
			expect(await previewOrder(store, doc, config)).toEqual(expected);
		});
});

describe("a date and time orders by its moment, whichever spelling a row holds", () => {
	// Rows saved before a phone wrote CommCare HQ's spelling keep the offset
	// they were saved with. Their text orders by the written clock; the list
	// orders by the moment, in every session zone.
	const SEEN: Record<string, string> = {
		"row-1": "2026-01-02T09:30:00.000000Z",
		"row-2": "2026-01-02T12:00:00.000+03:00",
		"row-3": "2026-01-02T04:45:00.000-05:00",
		"row-4": "2026-01-02T15:20:00.000+05:30",
		"row-5": "2026-01-02T09:40:00.000000Z",
	};
	const BY_MOMENT = ["row-2", "row-1", "row-5", "row-3", "row-4"];
	for (const sessionZone of ["UTC", "Asia/Kolkata", "America/Los_Angeles"])
		it(`in session zone ${sessionZone}`, async () => {
			const { doc, config } = orderedListDoc(
				{ name: "seen", data_type: "datetime" },
				columnSort("asc", 0),
			);
			const seeding = makeStore();
			await seeding.applySchemaChange({
				appId: APP_ID,
				caseType: CASE_TYPE,
				caseTypeSchemas: buildCaseTypeMap(doc),
			});
			for (const [caseId, seen] of Object.entries(SEEN))
				await seeding.insert({
					appId: APP_ID,
					row: {
						case_id: caseId,
						case_type: CASE_TYPE,
						case_name: caseId,
						status: "open",
						properties: { seen },
					},
				});
			const pool = new Pool({
				connectionString: dbHandle.uri,
				max: 1,
				options: `-c TimeZone=${sessionZone}`,
			});
			const db = new Kysely<Database>({
				dialect: new PostgresDialect({ pool }),
			});
			try {
				expect(await previewOrder(makeStore(db), doc, config)).toEqual(
					BY_MOMENT,
				);
			} finally {
				await db.destroy();
			}
		});
});
