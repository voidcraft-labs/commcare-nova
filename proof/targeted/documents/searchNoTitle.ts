/**
 * A search with no title, beside a search with one.
 *
 * `targeted-search-no-title` is two menus of clients, each searching by
 * name. The first menu's search holds `searchScreenTitle: { kind: "none" }`,
 * a search with no title; the second's holds the title "Find a client". Nova
 * writes the first's `title_label` blank in every language
 * (`lib/commcare/hqJson/caseList.ts`), as CommCare HQ's Case List page saves
 * a search where nothing was typed
 * (`views/modules.py::_gather_and_update_search_properties`); the app string
 * is that text (`models/case_search.py::CaseSearch.get_search_title_label`),
 * written as a non-breaking space (`commcare_translations.py::dumps`), and
 * Web Apps trims it and draws a heading only where something is left
 * (`formplayer/menus/views/query.js::templateContext`,
 * `partials/query/list.html`). Android draws no search title for either.
 * `proof/webapps/test_search_title.py` reads both search screens in the
 * client. The document declares both platforms.
 *
 * Fixed values: each visit's note holds the text the worker enters
 * (`./echo.ts`).
 */

import { buildDoc, f } from "@/lib/__tests__/docHelpers";
import {
	NO_SEARCH_SCREEN_TITLE,
	plainColumn,
	proseText,
	type SearchScreenTitle,
	simpleSearchInputDef,
} from "@/lib/domain";
import { caseListOf, targetedDocument, targetedUuid } from "../build";
import { answerHeld } from "./echo";

const ID = "targeted-search-no-title";
const uuid = (name: string) => targetedUuid(ID, name);
/** The title the second menu's search shows. */
export const SEARCH_TITLE = "Find a client";

function searchingMenu(
	key: string,
	name: string,
	searchScreenTitle: SearchScreenTitle,
) {
	return {
		uuid: uuid(`${key}-module`),
		name,
		caseType: "client",
		caseListConfig: caseListOf(
			[plainColumn(uuid(`${key}-name`), "case_name", "Name")],
			{
				searchInputs: [
					simpleSearchInputDef(
						uuid(`${key}-input`),
						"case_name",
						"Name",
						"text",
						"case_name",
					),
				],
			},
		),
		caseSearchConfig: { searchScreenTitle },
		forms: [
			{
				uuid: uuid(`${key}-visit`),
				name: "Visit",
				type: "followup" as const,
				fields: [
					f({
						kind: "text",
						uuid: uuid(`${key}-note`),
						id: "note",
						label: proseText("Note"),
					}),
				],
			},
		],
	};
}

export function searchNoTitle() {
	const doc = buildDoc({
		appId: ID,
		appName: "Client search titles",
		caseTypes: [
			{
				name: "client",
				properties: [{ name: "case_name", label: proseText("Name") }],
			},
		],
		modules: [
			searchingMenu("untitled", "Clients", NO_SEARCH_SCREEN_TITLE),
			searchingMenu("titled", "Clients by title", SEARCH_TITLE),
		],
	});
	return targetedDocument({
		id: ID,
		rows: ["case-search, a search with no title"],
		doc,
		expected: {
			intent: [
				answerHeld(
					"untitled-note-held",
					uuid("untitled-visit"),
					"/data/note",
					"seen",
					"local",
					{
						command: "m0-f0",
						caseId: "targeted-client",
					},
				),
				answerHeld(
					"titled-note-held",
					uuid("titled-visit"),
					"/data/note",
					"seen",
					"local",
					{
						command: "m1-f0",
						caseId: "targeted-client",
					},
				),
			],
		},
	});
}
