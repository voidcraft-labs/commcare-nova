/**
 * Case list columns that show a property of the case above the listed one
 * (`Column.via`).
 *
 * CommCare HQ's Case List page stores such a column's field as its indices and
 * its property joined by `/` (`parent/address`), and its build walks each
 * index over `casedb` (`detail_screen.py::PropertyXpathGenerator.xpath`). Nova
 * writes that field into HQ JSON and the same join into the local suite, for a
 * plain, a date and a phone column through `parent`, one through the custom
 * index `host` whose case type the column names, a sort over the related
 * address, and a tile cell over it. The lane holds HQ's build of the HQ JSON
 * to Nova's local suite, and Core's case list to the values below.
 *
 * Fixed values: Kito's household is on Alder Lane and Zawadi's on Birch Road,
 * so the list orders Kito first by the household's address; Zawadi's household
 * was visited on 1 March 2026 and answers on 555-0100, and her clinic is the
 * North clinic. Kito's household has no phone and no visit, and Kito no
 * clinic, so those cells are blank.
 */

import { buildDoc, f } from "@/lib/__tests__/docHelpers";
import {
	columnSort,
	dateColumn,
	phoneColumn,
	plainColumn,
	proseText,
	tileCell,
} from "@/lib/domain";
import { caseListOf, targetedDocument, targetedUuid } from "../build";
import { restoreXml } from "../restore";

const ID = "targeted-related-columns";
const uuid = (name: string) => targetedUuid(ID, name);
const PARENT = [{ identifier: "parent" }] as [{ identifier: string }];

export function relatedColumns() {
	const listForm = uuid("list-form");
	const tileForm = uuid("tile-form");
	const doc = buildDoc({
		appId: ID,
		appName: "Household members",
		caseTypes: [
			{
				name: "household",
				properties: [
					{ name: "case_name", label: proseText("Household") },
					{ name: "address", label: proseText("Address"), data_type: "text" },
					{
						name: "visit_date",
						label: proseText("Visited"),
						data_type: "date",
					},
					{ name: "phone", label: proseText("Phone"), data_type: "text" },
				],
			},
			{
				name: "clinic",
				properties: [{ name: "case_name", label: proseText("Clinic") }],
			},
			{
				name: "member",
				parent_type: "household",
				properties: [{ name: "case_name", label: proseText("Name") }],
			},
		],
		modules: [
			{
				uuid: uuid("list-module"),
				name: "Members",
				caseType: "member",
				caseListConfig: caseListOf([
					plainColumn(uuid("name"), "case_name", "Name"),
					plainColumn(uuid("address"), "address", "Address", {
						via: PARENT,
						sort: columnSort("asc", 0),
					}),
					dateColumn(uuid("visited"), "visit_date", "Visited", "%d/%m/%Y", {
						via: PARENT,
					}),
					phoneColumn(uuid("phone"), "phone", "Phone", { via: PARENT }),
					plainColumn(uuid("clinic"), "case_name", "Clinic", {
						via: [{ identifier: "host", throughCaseType: "clinic" }],
					}),
				]),
				forms: [
					{
						uuid: listForm,
						name: "Visit",
						type: "followup",
						fields: [
							f({
								kind: "text",
								uuid: uuid("list-notes"),
								id: "notes",
								label: proseText("Notes"),
							}),
						],
					},
				],
			},
			{
				uuid: uuid("tile-module"),
				name: "Members on tiles",
				caseType: "member",
				caseListConfig: caseListOf(
					[
						plainColumn(uuid("tile-name"), "case_name", "Name", {
							tile: tileCell(0, 0, 12, 1),
						}),
						plainColumn(uuid("tile-address"), "address", "Address", {
							via: PARENT,
							tile: tileCell(0, 1, 12, 1),
						}),
					],
					{ tile: {} },
				),
				forms: [
					{
						uuid: tileForm,
						name: "Check",
						type: "followup",
						fields: [
							f({
								kind: "text",
								uuid: uuid("tile-notes"),
								id: "notes",
								label: proseText("Notes"),
							}),
						],
					},
				],
			},
		],
	});
	const restore = restoreXml({
		cases: [
			{
				id: "targeted-house-birch",
				type: "household",
				name: "Birch house",
				properties: {
					address: "Birch Road",
					visit_date: "2026-03-01",
					phone: "555-0100",
				},
			},
			{
				id: "targeted-house-alder",
				type: "household",
				name: "Alder house",
				properties: { address: "Alder Lane" },
			},
			{
				id: "targeted-clinic-north",
				type: "clinic",
				name: "North clinic",
			},
			{
				id: "targeted-zawadi",
				type: "member",
				name: "Zawadi",
				indices: [
					{
						identifier: "parent",
						caseType: "household",
						caseId: "targeted-house-birch",
					},
					{
						identifier: "host",
						caseType: "clinic",
						caseId: "targeted-clinic-north",
						relationship: "extension",
					},
				],
			},
			{
				id: "targeted-kito",
				type: "member",
				name: "Kito",
				indices: [
					{
						identifier: "parent",
						caseType: "household",
						caseId: "targeted-house-alder",
					},
				],
			},
		],
	});
	return targetedDocument({
		id: ID,
		rows: [
			"a property column read through parent and through another index, sorted and in a tile",
		],
		doc,
		expected: {
			intent: [
				{
					id: "list-shows-and-orders-by-the-household",
					export: "local",
					form: listForm,
					restore: "restore.xml",
					request: { session: { command: "m0-f0" }, caseList: {} },
					expect: [
						{ pointer: "/caseList/rows/0/caseId", value: "targeted-kito" },
						{ pointer: "/caseList/rows/0/fields/1", value: "Alder Lane" },
						{ pointer: "/caseList/rows/0/fields/3", value: "" },
						{ pointer: "/caseList/rows/0/fields/4", value: "" },
						{ pointer: "/caseList/rows/1/caseId", value: "targeted-zawadi" },
						{ pointer: "/caseList/rows/1/fields/1", value: "Birch Road" },
						{ pointer: "/caseList/rows/1/fields/2", value: "01/03/2026" },
						{ pointer: "/caseList/rows/1/fields/3", value: "555-0100" },
						{ pointer: "/caseList/rows/1/fields/4", value: "North clinic" },
					],
				},
				{
					id: "search-matches-the-household",
					export: "local",
					form: listForm,
					restore: "restore.xml",
					request: {
						session: { command: "m0-f0" },
						caseList: { searchText: "Birch" },
					},
					expect: [
						{ pointer: "/caseList/rows/0/caseId", value: "targeted-zawadi" },
					],
				},
				{
					id: "tile-shows-the-household",
					export: "local",
					form: tileForm,
					restore: "restore.xml",
					request: {
						session: { command: "m1-f0" },
						caseList: { searchText: "Kito" },
					},
					expect: [
						{ pointer: "/caseList/rows/0/fields/1", value: "Alder Lane" },
					],
				},
			],
		},
		files: { "restore.xml": restore },
	});
}
