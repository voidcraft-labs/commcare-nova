/**
 * Defect 5, reserved substrings and the 32-character tag: a lookup-backed
 * select over a table whose tag splits `casedb` and holds Nova's full 32
 * characters, and one over a table whose tag splits `ledgerdb`.
 *
 * Every runtime resolves an instance by the first of three substrings its
 * source holds (commcare-core
 * `core/process/CommCareInstanceInitializer.java::generateRoot`: `ledgerdb`,
 * then `casedb`, then `fixture`), so a tag holding either word would read the
 * ledger or case database and offer nothing. Nova refuses such a tag
 * (`lib/lookup/constants.ts::reservedInstanceTagCause`), and these tags split
 * each word as the cutover's rename did (`case_db`, `ledger_db`), so each
 * select reads its table. The first tag is padded to `LOOKUP_MAX_TAG_LENGTH`, so
 * Nova's real push of a 32-character tag goes through HQ's upload, HQ's
 * restore serves it, and Core's sessions read it on both paths. The control
 * of the same name keeps the tags from before step 2 refused them.
 *
 * Fixed values: each table holds two rows, and the restore holds both tables
 * as HQ's restore serves them, so a select that reads its table counts two
 * rows there.
 */

import { buildDoc, f } from "@/lib/__tests__/docHelpers";
import {
	wireRow,
	wireTable,
} from "@/lib/commcare/lookup/__tests__/lookupWireCorpus";
import { proseText } from "@/lib/domain";
import { parseLookupRevision } from "@/lib/lookup/schema";
import { targetedDocument, targetedUuid } from "../build";
import { restoreXml } from "../restore";

const ID = "targeted-lookup-reserved-tags";
const uuid = (name: string) => targetedUuid(ID, name);

const CLINICS = "clinic_case_db_codes_0123456789a";
const STOCK = "stock_ledger_db_codes";

export function lookupReservedTags() {
	const clinics = wireTable(CLINICS, [
		{ name: "code", type: "text" },
		{ name: "name", type: "text" },
	]);
	const stock = wireTable(STOCK, [
		{ name: "code", type: "text" },
		{ name: "name", type: "text" },
	]);
	const clinicRows = [
		wireRow(clinics, "north", { code: "north", name: "North clinic" }),
		wireRow(clinics, "south", { code: "south", name: "South clinic" }),
	];
	const stockRows = [
		wireRow(stock, "soap", { code: "soap", name: "Soap" }),
		wireRow(stock, "salt", { code: "salt", name: "Salt" }),
	];
	const form = uuid("form");
	const source = (table: typeof clinics) => {
		const [code, name] = table.columns;
		if (code === undefined || name === undefined) {
			throw new Error(`The ${table.tag} table has no code and name columns.`);
		}
		return {
			kind: "lookup" as const,
			tableId: table.id,
			valueColumnId: code.id,
			labelColumnId: name.id,
		};
	};
	const doc = buildDoc({
		appId: ID,
		appName: "Reserved lookup tags",
		modules: [
			{
				uuid: uuid("module"),
				name: "Supplies",
				forms: [
					{
						uuid: form,
						name: "Order",
						type: "survey",
						fields: [
							f({
								kind: "single_select",
								uuid: uuid("clinic"),
								id: "clinic",
								label: proseText("Clinic"),
								optionsSource: source(clinics),
							}),
							f({
								kind: "single_select",
								uuid: uuid("item"),
								id: "item",
								label: proseText("Item"),
								optionsSource: source(stock),
							}),
						],
					},
				],
			},
		],
	});
	const lookup = {
		projectId: "project-targeted-lookup",
		projectRevision: parseLookupRevision("1"),
		definitions: [clinics, stock],
		rowsByTable: new Map([
			[clinics.id, clinicRows],
			[stock.id, stockRows],
		]),
	};
	const restore = restoreXml({
		tables: [
			{
				tag: CLINICS,
				fields: ["code", "name"],
				rows: [
					["north", "North clinic"],
					["south", "South clinic"],
				],
			},
			{
				tag: STOCK,
				fields: ["code", "name"],
				rows: [
					["soap", "Soap"],
					["salt", "Salt"],
				],
			},
		],
	});
	// Each select offers its table's two rows: the rows its instance holds.
	const counts = [
		`count(instance('${CLINICS}')/${CLINICS}_list/${CLINICS})`,
		`count(instance('${STOCK}')/${STOCK}_list/${STOCK})`,
	];
	const expectation = (exportName: "local" | "A") => ({
		id: `table-rows-${exportName === "local" ? "local" : "a"}`,
		export: exportName,
		form,
		restore: "restore.xml",
		request: { expressions: counts },
		expect: [
			{ pointer: "/values/0/value", value: "2" },
			{ pointer: "/values/1/value", value: "2" },
		],
	});
	return targetedDocument({
		id: ID,
		rows: ["5, reserved substrings"],
		doc,
		lookup,
		expected: { intent: [expectation("local"), expectation("A")] },
		files: { "restore.xml": restore },
	});
}
