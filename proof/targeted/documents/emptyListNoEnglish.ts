/**
 * Finding 41 in an app without English: the empty-list text a worker reads.
 *
 * Nova writes no `no_items_text`, so HQ's model default holds English alone
 * (`models/case_list.py::Detail.no_items_text`). Under
 * `USH_EMPTY_CASE_LIST_TEXT` HQ's module settings page, saved without a
 * change, writes an empty text for the page's language where it has none
 * (`views/modules.py::edit_module_attr`), and in an app whose languages hold
 * no English that blank is the only text HQ's app strings then carry for the
 * list. This app is written in Spanish alone, so its one language is the
 * page's, and the Web Apps tests (`proof/webapps/test_empty_list.py`) read
 * what a worker sees on an empty list before and after that save, under
 * the document's `maximum` configuration, which holds the flag.
 *
 * Fixed values: Amina is the one client, and a list search for a name no
 * client has leaves the list empty.
 */

import { buildDoc, f } from "@/lib/__tests__/docHelpers";
import { plainColumn, proseText } from "@/lib/domain";
import { caseListOf, targetedDocument, targetedUuid } from "../build";
import { restoreXml } from "../restore";

const ID = "targeted-empty-list-no-english";
const uuid = (name: string) => targetedUuid(ID, name);

export function emptyListNoEnglish() {
	const form = uuid("form");
	const doc = buildDoc({
		appId: ID,
		appName: "Clientes",
		caseTypes: [
			{
				name: "client",
				properties: [{ name: "case_name", label: proseText("Nombre") }],
			},
		],
		modules: [
			{
				uuid: uuid("module"),
				name: "Clientes",
				caseType: "client",
				caseListConfig: caseListOf([
					plainColumn(uuid("name"), "case_name", "Nombre"),
				]),
				forms: [
					{
						uuid: form,
						name: "Visita",
						type: "followup",
						fields: [
							f({
								kind: "text",
								uuid: uuid("notes"),
								id: "notes",
								label: proseText("Notas"),
							}),
						],
					},
				],
			},
		],
	});
	// Spanish is the app's source and only language: no English on the wire.
	doc.localization = {
		sourceLanguage: "spa",
		defaultLanguage: "spa",
		languageOrder: ["spa"],
		translations: {},
	};
	const restore = restoreXml({
		cases: [{ id: "targeted-amina", type: "client", name: "Amina" }],
	});
	return targetedDocument({
		id: ID,
		rows: ["41 (empty-list text without English)"],
		doc,
		expected: {
			intent: [
				{
					id: "amina-listed",
					export: "local",
					form,
					restore: "restore.xml",
					request: {
						session: { command: "m0-f0" },
						caseList: { searchText: "Amina" },
					},
					expect: [
						{ pointer: "/caseList/rows/0/caseId", value: "targeted-amina" },
						{ pointer: "/caseList/rows/0/fields/0", value: "Amina" },
					],
				},
			],
		},
		files: { "restore.xml": restore },
	});
}
