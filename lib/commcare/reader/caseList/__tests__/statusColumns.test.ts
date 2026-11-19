/**
 * Contract: a case list column over `status` or `owner_id` is the property column CommCare HQ's
 * Case List page stores (`field: "status"`, `useXpathExpression: false`; `status` is one of the
 * page's own defaults, `views/modules.py::_setup_case_property_builder`), which HQ's build reads
 * as the case's attribute through `detail_screen.py::CASE_PROPERTY_MAP` and names by that field
 * (`id_strings.py::detail_column_header_locale`, `m0.case_short.case_status_2.header`). Nova
 * writes it so, its own archive gives it the same id, and a reading of either spelling HQ stores
 * prints that spelling back, so a first publish over an app made in HQ keeps each column's
 * `field`, its `useXpathExpression` and the app string ids HQ's build gives it. The failure it
 * catches: a stored `status` column written back as the expression `@status`, which moves its
 * header's id to `case_calculated_property_2` and drops a `translations` override keyed by the
 * old one, with nothing declared.
 */
import { describe, expect, it } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import { buildDoc, f } from "@/lib/__tests__/docHelpers";
import type { HqApplication } from "@/lib/commcare";
import { emitShortDetail } from "@/lib/commcare/suite/case-list/shortDetail";
import { validateHqJson } from "@/lib/commcare/validator/hqJsonOracle";
import { runValidation } from "@/lib/commcare/validator/runner";
import { LOOKUP_CONTEXT_UNAVAILABLE } from "@/lib/doc/lookupReferences";
import {
	type BlueprintDoc,
	type Column,
	columnSort,
	orderedColumns,
	plainColumn,
} from "@/lib/domain";
import {
	type AppJson,
	codes,
	emittedApp,
	listOf,
	readLists,
} from "./listReading";

const NAME = testUuid("status-name");
const STATUS = testUuid("status-status");
const OWNER = testUuid("status-owner");

function patients(): BlueprintDoc {
	const columns: Column[] = [
		plainColumn(NAME, "case_name", "Name"),
		plainColumn(STATUS, "status", "Status", { sort: columnSort("asc", 0) }),
		plainColumn(OWNER, "owner_id", "Owner"),
	];
	return buildDoc({
		caseTypes: [{ name: "patient", properties: [] }],
		modules: [
			{
				name: "Patients",
				caseType: "patient",
				forms: [
					{
						name: "Register",
						type: "registration",
						fields: [
							f({
								kind: "text",
								id: "name",
								caseWrite: { caseType: "patient", property: "case_name" },
							}),
						],
					},
				],
				caseListConfig: {
					columns,
					listColumnOrder: columns.map((column) => column.uuid),
					detailColumnOrder: columns.map((column) => column.uuid),
					searchInputs: [],
				},
			},
		],
	});
}

type StoredColumn = { field: unknown; useXpathExpression?: unknown };
type StoredDetails = {
	short: { columns: StoredColumn[]; sort_elements: { field: unknown }[] };
	long: { columns: StoredColumn[] };
};

/** The first menu's two details as HQ stores them. */
const detailsOf = (app: AppJson): StoredDetails =>
	(app.modules[0] as Record<string, unknown>).case_details as StoredDetails;

/** Each column of both details as HQ stores it, its `field` and `useXpathExpression`. */
function storedColumns(app: AppJson): unknown {
	const pair = detailsOf(app);
	const of = (columns: StoredColumn[]) =>
		columns.map((column) => [column.field, column.useXpathExpression]);
	return {
		short: of(pair.short.columns),
		long: of(pair.long.columns),
		sort: pair.short.sort_elements.map((element) => element.field),
	};
}

describe("a column over status or owner_id", () => {
	const doc = patients();

	it("is HQ's property field, sorted by that field, and named by it in both archives", async () => {
		expect(runValidation(doc, LOOKUP_CONTEXT_UNAVAILABLE)).toEqual([]);
		const app = await emittedApp(doc);
		expect(storedColumns(app)).toEqual({
			short: [
				["name", false],
				["status", false],
				["owner_id", false],
			],
			long: [
				["name", false],
				["status", false],
				["owner_id", false],
			],
			sort: ["status"],
		});
		expect(validateHqJson(app as unknown as HqApplication)).toEqual([]);
		const mod = doc.modules[doc.moduleOrder[0]];
		const short = emitShortDetail({ module: mod, moduleIndex: 0, doc });
		expect(short.strings["m0.case_short.case_status_2.header"]).toBe("Status");
		expect(short.strings["m0.case_short.case_owner_id_3.header"]).toBe("Owner");
		const xml = short.xml.replaceAll("&apos;", "'");
		expect(xml).toContain('function="@status"');
		expect(xml).toContain('function="@owner_id"');
	});

	it("reads back as the property column, and prints the same columns again", async () => {
		const reading = await readLists(doc);
		expect(codes(reading)).toEqual([]);
		const read = orderedColumns(listOf(reading), "list");
		expect(
			read.map((column) => [column.kind, "field" in column && column.field]),
		).toEqual([
			["plain", "case_name"],
			["plain", "status"],
			["plain", "owner_id"],
		]);
		expect(
			storedColumns(await emittedApp(reading.ctx.doc as BlueprintDoc)),
		).toEqual(storedColumns(await emittedApp(doc)));
	});

	it("reads a stored `@status` expression as the calculated column it is, and prints it back so", async () => {
		const reading = await readLists(doc, {
			edit: (app) => {
				const pair = detailsOf(app);
				for (const detail of [pair.short, pair.long])
					for (const column of detail.columns)
						if (column.field === "owner_id") {
							column.field = "@owner_id";
							column.useXpathExpression = true;
						}
			},
		});
		expect(codes(reading)).toEqual([]);
		const read = listOf(reading).columns.find(
			(column) => column.header === "Owner",
		);
		expect(read?.kind).toBe("calculated");
		const printed = storedColumns(
			await emittedApp(reading.ctx.doc as BlueprintDoc),
		) as { short: unknown[]; long: unknown[] };
		expect(printed.short[2]).toEqual(["@owner_id", true]);
		expect(printed.long[2]).toEqual(["@owner_id", true]);
	});
});
