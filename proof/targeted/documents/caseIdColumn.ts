/**
 * Finding 57: a case list column over `case_id`, and a hidden order column
 * over `owner_id`.
 *
 * HQ's build reads a property column's `field` as a child element
 * (`detail_screen.py::PropertyXpathGenerator.xpath`: `CASE_PROPERTY_MAP`
 * maps `owner_id` and `status` to attributes and has no `case_id`), while
 * the case database holds the id only as an attribute, and HQ's Case List
 * page refuses an `@` in a property column's `field`
 * (`helpers/validators.py::ModuleDetailValidatorMixin._validate_detail_screen_field`,
 * `static/app_manager/js/details/utils.js::isValidPropertyName`). Nova once
 * sent the shown column over `case_id` as a property column, blank on HQ's
 * build, and the hidden one over `owner_id` with the attribute in a property
 * field, which the page would not save. Every column over `case_id`,
 * `owner_id` or `status` is now an expression column over the attribute
 * (`lib/domain/caseListOrder.ts`, rule 2); the document is a witness.
 *
 * Fixed values: each row's ID column shows the case's own id.
 */

import { buildDoc, f } from "@/lib/__tests__/docHelpers";
import {
	idMappingColumn,
	idMappingEntry,
	linkColumn,
	plainColumn,
	proseText,
} from "@/lib/domain";
import { caseListOf, targetedDocument, targetedUuid } from "../build";
import { RESTORE_USER_ID, restoreXml } from "../restore";

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

const ATTRIBUTES_ID = "targeted-attribute-columns";
const attributesUuid = (name: string) => targetedUuid(ATTRIBUTES_ID, name);

/**
 * Finding 57: every column over a case attribute, as Nova writes it.
 *
 * The first list shows a column over each of `owner_id`, `status` and
 * `case_id`, an ID mapping over `status`, and holds a column over `case_id`
 * hidden from Results that carries the list's only order rule. Each is an
 * expression column over the attribute, `@<name>` with
 * `useXpathExpression: true`, which HQ uses verbatim
 * (`detail_screen.py::FormattedDetailColumn.xpath`), and the order rule is
 * the positional element `_cc_calculated_5`. HQ gives an element to the
 * first column whose `field` is its text (`suite_xml/sections/details.py::
 * get_detail_column_infos`), so on HQ's build and in the local suite alike
 * the rule sits on the shown `case_id` column, which orders by the same
 * value.
 *
 * The second list orders by a shown link over `status`, the one shape that
 * still writes a sort row over a bare property name: no column's `field` is
 * `status`, so HQ appends a hidden field for the row
 * (`app_manager/util.py::create_temp_sort_column`) that reads `@status`
 * through `detail_screen.py::CASE_PROPERTY_MAP`, and the local suite appends
 * the same field. Every listed case is open, so that list claims no order.
 *
 * Fixed values: Baraka's id, `targeted-1-baraka`, comes before Amina's,
 * `targeted-2-amina`, though her name comes first, so the first list shows
 * Baraka first. Each field shows the case's own value: the restore's user
 * owns every case, every case is open, and the ID mapping reads `Open `,
 * with the space HQ's ID mapping joins its entries' texts with
 * (`suite_xml/xml_models.py::XPathEnum.build`).
 */
export function attributeColumns() {
	const followup = attributesUuid("followup");
	const visit = (name: string) => ({
		uuid: attributesUuid(`${name}-form`),
		name: "Visit",
		type: "followup" as const,
		fields: [
			f({
				kind: "text",
				uuid: attributesUuid(`${name}-notes`),
				id: "notes",
				label: proseText("Notes"),
			}),
		],
	});
	const doc = buildDoc({
		appId: ATTRIBUTES_ID,
		appName: "Client attributes",
		caseTypes: [
			{
				name: "client",
				properties: [{ name: "case_name", label: proseText("Name") }],
			},
		],
		modules: [
			{
				uuid: attributesUuid("records"),
				name: "Clients by record",
				caseType: "client",
				caseListConfig: caseListOf([
					plainColumn(attributesUuid("name"), "case_name", "Name"),
					plainColumn(attributesUuid("owner"), "owner_id", "Owner"),
					plainColumn(attributesUuid("status"), "status", "Status"),
					idMappingColumn(attributesUuid("state"), "status", "State", [
						idMappingEntry("open", "Open"),
						idMappingEntry("closed", "Closed"),
					]),
					plainColumn(attributesUuid("record-id"), "case_id", "Record ID"),
					plainColumn(
						attributesUuid("record-order"),
						"case_id",
						"Record order",
						{
							visibleInList: false,
							sort: ASCENDING,
						},
					),
				]),
				forms: [{ ...visit("records"), uuid: followup }],
			},
			{
				uuid: attributesUuid("statuses"),
				name: "Clients by status",
				caseType: "client",
				caseListConfig: caseListOf([
					plainColumn(attributesUuid("statuses-name"), "case_name", "Name"),
					linkColumn(
						attributesUuid("status-link"),
						"status",
						"Status link",
						"Status",
						{ sort: ASCENDING },
					),
				]),
				forms: [visit("statuses")],
			},
		],
	});
	const restore = restoreXml({
		cases: [
			{ id: "targeted-2-amina", type: "client", name: "Amina" },
			{ id: "targeted-1-baraka", type: "client", name: "Baraka" },
		],
	});
	return targetedDocument({
		id: ATTRIBUTES_ID,
		rows: ["57 (every column over a case attribute)"],
		doc,
		expected: {
			intent: [
				{
					id: "rows-in-id-order",
					export: "local",
					form: followup,
					restore: "restore.xml",
					request: {
						session: { command: "m0-f0" },
						caseList: {},
					},
					expect: [
						{ pointer: "/caseList/rows/0/caseId", value: "targeted-1-baraka" },
						{ pointer: "/caseList/rows/1/caseId", value: "targeted-2-amina" },
						{ pointer: "/caseList/rows/0/fields/0", value: "Baraka" },
						{ pointer: "/caseList/rows/0/fields/1", value: RESTORE_USER_ID },
						{ pointer: "/caseList/rows/0/fields/2", value: "open" },
						{
							pointer: "/caseList/rows/0/fields/4",
							value: "targeted-1-baraka",
						},
					],
				},
				{
					id: "status-mapping-shown",
					export: "local",
					form: followup,
					restore: "restore.xml",
					request: {
						session: { command: "m0-f0" },
						caseList: {},
					},
					expect: [{ pointer: "/caseList/rows/0/fields/3", value: "Open " }],
				},
			],
		},
		files: { "restore.xml": restore },
	});
}
