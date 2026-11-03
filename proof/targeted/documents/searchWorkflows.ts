/**
 * What a worker sees first when a menu searches: the search workflow
 * (`caseSearchConfig.workflow`, absent for search first) and whether the
 * menu's forms read the search (`caseSearchConfig.formsReadSearch`), one
 * document per platform declaration.
 *
 * CommCare HQ's Case List page shows its Web Apps search workflow selector
 * where the app has Web Apps on, the project space has the `CLOUDCARE`
 * privilege and `SYNC_SEARCH_CASE_CLAIM` is on
 * (`corehq/apps/app_manager/views/modules.py::get_module_view_context`,
 * `show_search_workflow`). The selector offers Search First (`auto_launch`)
 * and Skip to Default Case Search Results (`es_only`), and Legacy Case
 * Search (`classic`, list first) only under
 * `CASE_SEARCH_DEPRECATED_NORMAL_CASE_LIST`
 * (`templates/app_manager/partials/modules/bootstrap5/case_search_properties.html`),
 * so a save of a list-first menu there turns it search first (defect 21).
 * Nova authors list first only where Web Apps is not declared, so every
 * workflow these documents hold is one the page offers and its save keeps.
 *
 * - `targeted-search-workflow` (both platforms): one case type and three
 *   searching menus, none whose forms read the search. "Find patient" opens
 *   on Search first with a visible field and a Search button condition;
 *   "Nearby patients" opens on Search first with only a hidden field;
 *   "Recent patients" skips to the results of its search, with a visible
 *   field. Web Apps opens each as the workflow says, and a device opens each
 *   on its case list, which it reads no `auto_launch` for.
 * - `targeted-search-workflow-inline` (Web Apps): two menus whose forms read
 *   the search. "Find visit" opens on Search first with only a hidden field;
 *   "Look up client" skips to its results with a visible field, and offers
 *   "Register client" as its case list registration form, under the label
 *   "Add a new client", where a search finds nothing. Forms that read the
 *   search run in Web Apps alone (`forms-read-search`).
 * - `targeted-search-workflow-android` (Android): "Find patient" opens on its
 *   case list with a Search action (`workflow: "listFirst"`), with a visible
 *   field. The app is no Web App, so HQ's Case List page draws no selector
 *   and its save keeps `auto_launch: false`.
 *
 * Fixed values: each case form's note holds the text the worker enters
 * (`./echo.ts`), on the export the document's platforms have.
 */

import { buildDoc, f } from "@/lib/__tests__/docHelpers";
import {
	type BlueprintDoc,
	type CaseListConfig,
	type HiddenSearchInputDef,
	NEW_APP_SETTINGS,
	type OrdinaryCaseSearchConfig,
	plainColumn,
	proseText,
	simpleSearchInputDef,
	type Uuid,
} from "@/lib/domain";
import { eq, literal, sessionUser, term } from "@/lib/domain/expression";
import { caseListOf, targetedDocument, targetedUuid } from "../build";
import type { Expectation } from "../expected";
import { answerHeld } from "./echo";

/** One searching menu of a document: its name, case type, search and forms. */
interface SearchingMenu {
	readonly key: string;
	readonly name: string;
	readonly caseType: string;
	readonly search: OrdinaryCaseSearchConfig;
	readonly inputs: "visible" | "hidden";
	/** A registration form the menu's case list offers after a search finds nothing. */
	readonly registration?: { readonly label: string };
}

/** The namer of one document's identities. */
function namer(id: string) {
	return (name: string): Uuid => targetedUuid(id, name);
}

/** The case list of `menu`: a name column and its one Search field. */
function searchList(
	uuid: (name: string) => Uuid,
	menu: SearchingMenu,
): CaseListConfig {
	const hidden: HiddenSearchInputDef = {
		uuid: uuid(`${menu.key}-input`),
		kind: "hidden",
		name: "area",
		label: "Area",
		value: term(literal("north")),
	};
	return caseListOf(
		[plainColumn(uuid(`${menu.key}-name-column`), "case_name", "Name")],
		{
			searchInputs: [
				menu.inputs === "visible"
					? simpleSearchInputDef(
							uuid(`${menu.key}-input`),
							"patient_name",
							"Name",
							"text",
							"case_name",
						)
					: hidden,
			],
		},
	);
}

/** An app of `menus`, each with a follow-up form "Note" (and its registration where it offers one). */
function searchingApp(
	id: string,
	appName: string,
	runsOnlyOn: "web-apps" | "android" | undefined,
	menus: readonly SearchingMenu[],
): BlueprintDoc {
	const uuid = namer(id);
	const caseTypes = [...new Set(menus.map((menu) => menu.caseType))];
	return buildDoc({
		appId: id,
		appName,
		...(runsOnlyOn !== undefined && {
			appSettings: { ...NEW_APP_SETTINGS, runsOnlyOn },
		}),
		caseTypes: caseTypes.map((name) => ({
			name,
			properties: [
				{ name: "case_name", label: proseText("Name") },
				{ name: "area", label: proseText("Area"), data_type: "text" as const },
			],
		})),
		modules: menus.map((menu) => ({
			uuid: uuid(menu.key),
			name: menu.name,
			caseType: menu.caseType,
			caseSearchConfig: menu.search,
			caseListConfig: searchList(uuid, menu),
			...(menu.registration !== undefined && {
				caseListRegistrationForm: {
					formUuid: uuid(`${menu.key}-register`),
					label: menu.registration.label,
				},
			}),
			forms: [
				{
					uuid: uuid(`${menu.key}-note`),
					name: "Note",
					type: "followup" as const,
					fields: [
						f({
							kind: "text",
							uuid: uuid(`${menu.key}-note-text`),
							id: "note",
							label: proseText("Note"),
						}),
					],
				},
				...(menu.registration === undefined
					? []
					: [
							{
								uuid: uuid(`${menu.key}-register`),
								name: `Register ${menu.caseType}`,
								type: "registration" as const,
								fields: [
									f({
										kind: "text",
										uuid: uuid(`${menu.key}-register-name`),
										id: "case_name",
										label: proseText("Name"),
										caseWrite: {
											caseType: menu.caseType,
											property: "case_name",
										},
									}),
								],
							},
						]),
			],
		})),
	});
}

/** Each menu's note, answered on its follow-up form over a case of its type. */
function notesHeld(
	id: string,
	menus: readonly SearchingMenu[],
	exportName: Expectation["export"],
): Expectation[] {
	const uuid = namer(id);
	return menus.map((menu, index) =>
		answerHeld(
			`${menu.key}-note-held`,
			uuid(`${menu.key}-note`),
			"/data/note",
			"seen",
			exportName,
			{ command: `m${index}-f0`, caseId: `targeted-${menu.caseType}` },
		),
	);
}

const BOTH_MENUS: readonly SearchingMenu[] = [
	{
		key: "find",
		name: "Find patient",
		caseType: "patient",
		search: {
			searchButtonDisplayCondition: eq(
				sessionUser("user_type"),
				literal("standard"),
			),
		},
		inputs: "visible",
	},
	{
		key: "nearby",
		name: "Nearby patients",
		caseType: "patient",
		search: {},
		inputs: "hidden",
	},
	{
		key: "recent",
		name: "Recent patients",
		caseType: "patient",
		search: { workflow: "skipToResults" },
		inputs: "visible",
	},
];

export function searchWorkflow() {
	const id = "targeted-search-workflow";
	return targetedDocument({
		id,
		rows: [
			"21",
			"search workflow: search first and skip to results, with and without a visible field",
		],
		doc: searchingApp(id, "Search workflows", undefined, BOTH_MENUS),
		expected: { intent: notesHeld(id, BOTH_MENUS, "local") },
	});
}

const INLINE_MENUS: readonly SearchingMenu[] = [
	{
		key: "visits",
		name: "Find visit",
		caseType: "visit",
		search: { formsReadSearch: true },
		inputs: "hidden",
	},
	{
		key: "clients",
		name: "Look up client",
		caseType: "client",
		search: { workflow: "skipToResults", formsReadSearch: true },
		inputs: "visible",
		registration: { label: "Add a new client" },
	},
];

export function searchWorkflowInline() {
	const id = "targeted-search-workflow-inline";
	return targetedDocument({
		id,
		rows: [
			"29",
			"search workflow: forms that read the search, search first and skip to results",
		],
		doc: searchingApp(id, "Inline search workflows", "web-apps", INLINE_MENUS),
		expected: { intent: notesHeld(id, INLINE_MENUS, "A") },
	});
}

const ANDROID_MENUS: readonly SearchingMenu[] = [
	{
		key: "find",
		name: "Find patient",
		caseType: "patient",
		search: { workflow: "listFirst" },
		inputs: "visible",
	},
];

export function searchWorkflowAndroid() {
	const id = "targeted-search-workflow-android";
	return targetedDocument({
		id,
		rows: ["search workflow: list first where Web Apps is not declared"],
		doc: searchingApp(id, "List first on a device", "android", ANDROID_MENUS),
		expected: { intent: notesHeld(id, ANDROID_MENUS, "local") },
	});
}
