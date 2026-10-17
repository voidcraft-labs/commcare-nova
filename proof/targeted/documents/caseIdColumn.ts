/**
 * Finding 57: a case list column over `case_id` is blank on HQ's build.
 *
 * Nova sends a shown column over `case_id` to HQ as a property column with
 * `field: "case_id"` (`lib/commcare/hqJson/caseList.ts::projectColumnToDetail`),
 * which HQ's build reads as a child element
 * (`detail_screen.py::PropertyXpathGenerator.xpath`: `CASE_PROPERTY_MAP` maps
 * `owner_id` and `status` to attributes and has no `case_id`), while the case
 * database holds the id only as an attribute, so the column is blank on HQ's
 * build and shows the id in Nova's local archive (`@case_id`). A hidden
 * column over `owner_id` that carries the list's only order rule is written
 * with the attribute spelling in a property field, which HQ's Case List page
 * refuses to save (`helpers/validators.py::ModuleDetailValidatorMixin._validate_detail_screen_field`,
 * `static/app_manager/js/details/utils.js::isValidPropertyName`).
 *
 * Fixed values: each row's ID column shows the case's own id.
 */

import { buildDoc, f } from "@/lib/__tests__/docHelpers";
import { plainColumn, proseText } from "@/lib/domain";
import { caseListOf, targetedDocument, targetedUuid } from "../build";
import { restoreXml } from "../restore";

const ID = "targeted-case-id-column";
const uuid = (name: string) => targetedUuid(ID, name);
const ASCENDING = { direction: "asc", priority: 0 } as const;

export function caseIdColumn() {
	const followup = uuid("followup");
	const doc = buildDoc({
		appId: ID,
		appName: "Client records",
		caseTypes: [
			{
				name: "client",
				properties: [
					{ name: "case_name", label: proseText("Name") },
					{ name: "notes", label: proseText("Notes"), data_type: "text" },
				],
			},
		],
		modules: [
			{
				uuid: uuid("module"),
				name: "Clients",
				caseType: "client",
				caseListConfig: caseListOf([
					plainColumn(uuid("name"), "case_name", "Name"),
					plainColumn(uuid("record-id"), "case_id", "Record ID"),
					plainColumn(uuid("owner"), "owner_id", "Owner", {
						visibleInList: false,
						sort: ASCENDING,
					}),
				]),
				forms: [
					{
						uuid: followup,
						name: "Visit",
						type: "followup",
						fields: [
							f({
								kind: "text",
								uuid: uuid("notes"),
								id: "notes",
								label: proseText("Notes"),
								caseWrite: { caseType: "client", property: "notes" },
							}),
						],
					},
				],
			},
		],
	});
	const restore = restoreXml({
		cases: [
			{ id: "targeted-amina", type: "client", name: "Amina" },
			{ id: "targeted-baraka", type: "client", name: "Baraka" },
		],
	});
	const row = (name: string, caseId: string) => ({
		id: `${name.toLowerCase()}-record-id`,
		export: "local" as const,
		form: followup,
		restore: "restore.xml",
		request: {
			session: { command: "m0-f0" },
			caseList: { searchText: name },
		},
		expect: [
			{ pointer: "/caseList/rows/0/caseId", value: caseId },
			{ pointer: "/caseList/rows/0/fields/0", value: name },
			{ pointer: "/caseList/rows/0/fields/1", value: caseId },
		],
	});
	return targetedDocument({
		id: ID,
		rows: ["57"],
		doc,
		expected: {
			intent: [
				row("Amina", "targeted-amina"),
				row("Baraka", "targeted-baraka"),
			],
		},
		files: { "restore.xml": restore },
	});
}
