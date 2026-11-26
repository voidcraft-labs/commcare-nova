import { expect, it } from "vitest";
import * as XLSX from "xlsx";
import { selectedWorkbookGrids } from "@/lib/agent/officeConversion";
import {
	bindWorkbookOwners,
	lookupWorkbookCandidates,
	observeLookupWorkbook,
	selectedLookupSheets,
} from "../hq/lookupWorkbook";

const rowId = "1".repeat(32);
const table = {
	id: "2".repeat(32),
	tag: "clinics",
	isGlobal: false,
	fields: ["code", "name"],
	fieldProperties: { code: [], name: ["lang"] },
	itemAttributes: ["region"],
};
const row: import("../hq/lookupTables").HqFixtureRow = {
	id: rowId,
	itemAttributes: { region: "north" },
	fields: {
		code: [
			{ value: " 007 ", properties: {} },
			{ value: "another", properties: {} },
		],
		name: [
			{ value: "", properties: { lang: "sw" } },
			{ value: " North ", properties: {} },
		],
	},
};
const def = [
	[
		"Delete(Y/N)",
		"table_id",
		"is_global?",
		"field 1",
		"field 2",
		"field 2: is_indexed?",
		"property 1",
		"field 2 : property 1",
	],
	["N", "clinics", "no", "code", "name", "yes", "region", "lang"],
];
const items = [
	[
		"UID",
		"Delete(Y/N)",
		"field: code",
		"name: lang 1",
		"field: name 1",
		"name: lang 2",
		"field: name 2",
		"property: region",
		"group 1",
	],
	[rowId, "N", " 007 ", "sw", "", "", " North ", "north", "Clinic team"],
];
function bytes(
	definition: string[][],
	values: string[][],
	alter?: (book: XLSX.WorkBook) => void,
) {
	const book = XLSX.utils.book_new();
	XLSX.utils.book_append_sheet(
		book,
		XLSX.utils.aoa_to_sheet(definition),
		"types",
	);
	XLSX.utils.book_append_sheet(
		book,
		XLSX.utils.aoa_to_sheet(values),
		"clinics",
	);
	alter?.(book);
	return XLSX.write(book, { bookType: "xlsx", type: "buffer" });
}
it("joins the selected native workbook facts to exact ordered source identities without flattening the independent occurrence data", () => {
	const selected = selectedLookupSheets.parse(
		selectedWorkbookGrids(bytes(def, items), "clinics"),
	);
	const observed = observeLookupWorkbook(table, [row], selected);
	expect(lookupWorkbookCandidates(selected)).toEqual([rowId]);
	expect(observed).toMatchObject({
		indexedFields: ["name"],
		owners: [
			{ rowId, owners: { group: ["Clinic team"], user: [], location: [] } },
		],
	});
	expect(
		bindWorkbookOwners(observed, [
			{ id: "group-id", kind: "group", name: "Clinic team" },
		])[0].owners.group,
	).toEqual([{ id: "group-id", name: "Clinic team" }]);
	expect(() => bindWorkbookOwners(observed, [])).toThrow();
	expect(() =>
		bindWorkbookOwners(
			observed,
			["a", "b"].map((id) => ({ id, kind: "group", name: "Clinic team" })),
		),
	).toThrow();
});
it.each([
	"extra-sheet",
	"formula",
	"typed-number",
	"stale-id",
	"duplicate-row",
	"stale-value",
	"schema",
] as const)("refuses %s before issuing an attestation", (fault) => {
	const data = structuredClone(items),
		schema = structuredClone(def);
	if (fault === "stale-id") data[1][0] = "3".repeat(32);
	if (fault === "duplicate-row") data.push(data[1]);
	if (fault === "stale-value") data[1][2] = "007";
	if (fault === "schema") schema[1][7] = "other";
	const workbook = bytes(schema, data, (book) => {
		if (fault === "extra-sheet")
			XLSX.utils.book_append_sheet(
				book,
				XLSX.utils.aoa_to_sheet([["unrelated"]]),
				"unrelated",
			);
		if (fault === "formula")
			book.Sheets.clinics.C2 = { f: "1+1", v: " 007 ", t: "s" };
		if (fault === "typed-number") book.Sheets.clinics.C2 = { v: 7, t: "n" };
	});
	expect(() =>
		observeLookupWorkbook(
			table,
			[row],
			selectedLookupSheets.parse(selectedWorkbookGrids(workbook, "clinics")),
		),
	).toThrow();
});
