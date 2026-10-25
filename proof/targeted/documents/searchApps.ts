/**
 * Searches whose symptoms show where HQ reads a search's configuration: its
 * Case List page, its Web Apps workflow selector, and its search endpoint.
 *
 * - `targeted-search-default-filter-name` (defect 14, search settings): a
 *   search input named `_xpath_query_2`, beside a case list filter, which
 *   Nova writes as a default filter named `_xpath_query`
 *   (`lib/commcare/hqJson/caseList.ts::projectDefaultProperties`). HQ's Case
 *   List page refuses to save a search property that shares a default
 *   property's name (`details/case_claim.js::commonProperties`), so Nova
 *   refuses an input named `_xpath_query`
 *   (`CASE_LIST_SEARCH_INPUT_NAME_IS_DEFAULT_FILTER`); this witness holds
 *   that the save goes through with the suffixed name.
 * - `targeted-sync-on-form-entry` (defect 20, sync on form entry): a
 *   list-first menu that offers search, whose follow-up form loads the case
 *   the worker picks, published to a project space with sync cases on form
 *   entry on. HQ's build gives the form's entry a claim of the picked case
 *   (`suite_xml/post_process/remote_requests.py`, the setting read through
 *   `case_search_sync_cases_on_form_entry_enabled_for_domain`), so Core's
 *   session asks for a sync before it opens the form
 *   (`CommCareSession.getNeededData`), which Nova's local archive never asks.
 *   From step 4 Nova's publish asks a person to confirm the setting is off
 *   for an app that declares Android and opens a searched case in a form, so
 *   the document is published with it off and its two paths agree; its
 *   control keeps the session from before the fix.
 * - `targeted-sync-on-form-entry-web-apps` (defect 21, and defect 20's
 *   setting where it is no harm): the same app declared Web Apps only and
 *   published with sync cases on form entry on, which Nova's publish accepts
 *   for an app no phone runs; it carries defect 21's `requests` class, which
 *   the Case List save shows under that setting.
 * - `targeted-list-first-web-apps` (defect 21): a list-first menu that
 *   offers search, in an app with Web Apps on, so HQ's Case List page shows
 *   its search workflow selector (`views/modules.py::get_module_view_context`,
 *   `show_search_workflow`: the app's `cloudcare_enabled`, the `CLOUDCARE`
 *   privilege and `SYNC_SEARCH_CASE_CLAIM`), which offers no list-first
 *   choice, and the save turns the menu search-first.
 * - `targeted-search-hq-compile` (defects 6 CSQL, 14 reserved input
 *   names; finding 48): a default filter that compares `date_opened` with a
 *   date turned into a date and time, which HQ's CSQL compiler takes as an
 *   explicit instant (`case_search/xpath_functions/comparison.py::property_comparison_query`),
 *   and one free-text input, `owner_id`, on the case's owner. Its control
 *   keeps the filters that ordered a time property and asked whether
 *   `date_opened` is blank, both of which HQ's compiler refuses. Nova writes the exact
 *   input on the owner into the query as `@owner_id`
 *   (`lib/commcare/suite/case-search/simpleArmDerivation.ts::simpleArmNeedsXPathQueryEmission`),
 *   so its prompt is excluded from the request's own keys and its answer
 *   goes through the quote cascade. The input HQ read as configuration,
 *   `include_closed`, is gone: Nova refuses a name HQ's search request
 *   reads (`CASE_LIST_SEARCH_INPUT_NAME_RESERVED`), and the document's
 *   control keeps the input as it was.
 * - `targeted-search-related-lookups` (defect 12, related lookups): a default
 *   filter on a property of the parent case, which HQ's CSQL compiler refuses
 *   in a case search unless the project space has
 *   `CASE_SEARCH_RELATED_LOOKUPS` (`filter_dsl.py::_require_related_lookups_flag`,
 *   checked only while the filter compiles, at search time), which the intent
 *   check runs on every CSQL string a search of HQ's build can send
 *   (`proof/observe/intent.py::search_compiles`).
 *
 * Fixed values: each follow-up form's note holds the text the worker
 * enters (`./echo.ts`).
 */

import { buildDoc, f } from "@/lib/__tests__/docHelpers";
import {
	type BlueprintDoc,
	type CaseListConfig,
	plainColumn,
	proseText,
	simpleSearchInputDef,
} from "@/lib/domain";
import {
	ancestorPath,
	dateLiteral,
	datetimeCoerce,
	eq,
	gte,
	literal,
	prop,
	relationStep,
	term,
} from "@/lib/domain/expression";
import { caseListOf, targetedDocument, targetedUuid } from "../build";
import { answerHeld } from "./echo";

function searchApp(
	id: string,
	appName: string,
	config: (uuid: (name: string) => ReturnType<typeof targetedUuid>) => {
		readonly list: CaseListConfig;
		readonly properties: readonly {
			readonly name: string;
			readonly data_type?: "text" | "time";
		}[];
		readonly parentType?: string;
	},
	withLocation = false,
): { doc: BlueprintDoc; form: ReturnType<typeof targetedUuid> } {
	const uuid = (name: string) => targetedUuid(id, name);
	const form = uuid("form");
	const { list, properties, parentType } = config(uuid);
	const doc = buildDoc({
		appId: id,
		appName,
		caseTypes: [
			...(parentType === undefined
				? []
				: [
						{
							name: parentType,
							properties: [
								{ name: "case_name", label: proseText("Name") },
								{
									name: "village",
									label: proseText("Village"),
									data_type: "text" as const,
								},
							],
						},
					]),
			{
				name: "patient",
				...(parentType !== undefined && { parent_type: parentType }),
				properties: [
					{ name: "case_name", label: proseText("Name") },
					...properties.map(({ name, data_type }) => ({
						name,
						label: proseText(name),
						data_type: data_type ?? ("text" as const),
					})),
				],
			},
		],
		modules: [
			{
				uuid: uuid("module"),
				name: "Patients",
				caseType: "patient",
				caseListConfig: list,
				forms: [
					{
						uuid: form,
						name: "Visit",
						type: "followup",
						fields: [
							f({
								kind: "text",
								uuid: uuid("note"),
								id: "note",
								label: proseText("Note"),
							}),
							...(withLocation
								? [
										f({
											kind: "geopoint",
											uuid: uuid("place"),
											id: "place",
											label: proseText("Place"),
										}),
									]
								: []),
						],
					},
				],
			},
		],
	});
	return { doc, form };
}

/** The visit opened on a patient: the note holds what the worker enters. */
function noteHeld(form: ReturnType<typeof targetedUuid>) {
	return {
		intent: [
			answerHeld("note-held", form, "/data/note", "seen", "local", {
				command: "m0-f0",
				caseId: "targeted-patient",
			}),
		],
	};
}

export function searchDefaultFilterName() {
	const id = "targeted-search-default-filter-name";
	const { doc, form } = searchApp(id, "Regional search", (uuid) => ({
		properties: [{ name: "region" }],
		list: caseListOf([plainColumn(uuid("name"), "case_name", "Name")], {
			filter: eq(prop("patient", "region"), literal("north")),
			searchInputs: [
				simpleSearchInputDef(
					uuid("input"),
					"_xpath_query_2",
					"Region",
					"text",
					"region",
				),
			],
		}),
	}));
	return targetedDocument({
		id,
		rows: ["14, search settings (an input named like a default filter)"],
		doc,
		expected: noteHeld(form),
	});
}

/** The claimed visits app: a list-first menu with Search over a follow-up form. */
function claimedVisits(id: string) {
	return searchApp(id, "Claimed visits", (uuid) => ({
		properties: [],
		list: caseListOf([plainColumn(uuid("name"), "case_name", "Name")], {
			searchInputs: [
				simpleSearchInputDef(
					uuid("input"),
					"case_name",
					"Name",
					"text",
					"case_name",
				),
			],
		}),
	}));
}

export function syncOnFormEntry() {
	const id = "targeted-sync-on-form-entry";
	const { doc, form } = claimedVisits(id);
	return targetedDocument({
		id,
		rows: ["20, sync on form entry (the session)"],
		doc,
		expected: noteHeld(form),
	});
}

export function syncOnFormEntryWebApps() {
	const id = "targeted-sync-on-form-entry-web-apps";
	const { doc, form } = claimedVisits(id);
	return targetedDocument({
		id,
		rows: [
			"21",
			"20, sync on form entry (an app for Web Apps only, where Nova asks nothing)",
		],
		doc: {
			...doc,
			appSettings: { ...doc.appSettings, runsOnlyOn: "web-apps" },
		},
		expected: {
			intent: [
				answerHeld("note-held", form, "/data/note", "seen", "A", {
					command: "m0-f0",
					caseId: "targeted-patient",
				}),
			],
		},
		projectSettings: { syncCasesOnFormEntry: true },
	});
}

export function listFirstWebApps() {
	const id = "targeted-list-first-web-apps";
	const { doc, form } = searchApp(id, "List first", (uuid) => ({
		properties: [],
		list: caseListOf([plainColumn(uuid("name"), "case_name", "Name")], {
			searchInputs: [
				simpleSearchInputDef(
					uuid("input"),
					"case_name",
					"Name",
					"text",
					"case_name",
				),
			],
		}),
	}));
	return targetedDocument({
		id,
		rows: ["21"],
		doc,
		expected: noteHeld(form),
		privileges: ["CLOUDCARE"],
	});
}

/** A location question keeps a phone-place walk behind the list-first menu. */
export function listFirstPlaces() {
	const id = "targeted-list-first-places";
	const { doc, form } = searchApp(
		id,
		"List first with places",
		(uuid) => ({
			properties: [],
			list: caseListOf([plainColumn(uuid("name"), "case_name", "Name")], {
				searchInputs: [
					simpleSearchInputDef(
						uuid("input"),
						"case_name",
						"Name",
						"text",
						"case_name",
					),
				],
			}),
		}),
		true,
	);
	return targetedDocument({
		id,
		rows: ["21"],
		doc,
		expected: noteHeld(form),
		privileges: ["CLOUDCARE"],
	});
}

export function searchHqCompile() {
	const id = "targeted-search-hq-compile";
	const { doc, form } = searchApp(id, "Search HQ compiles", (uuid) => ({
		properties: [{ name: "visit_time", data_type: "time" }],
		list: caseListOf([plainColumn(uuid("name"), "case_name", "Name")], {
			filter: gte(
				prop("patient", "date_opened"),
				datetimeCoerce(term(dateLiteral("2026-01-01"))),
			),
			searchInputs: [
				simpleSearchInputDef(
					uuid("owner"),
					"owner_id",
					"Owner",
					"text",
					"owner_id",
				),
			],
		}),
	}));
	return targetedDocument({
		id,
		rows: ["6, CSQL", "14, search settings (reserved input names)"],
		doc,
		expected: noteHeld(form),
	});
}

export function searchRelatedLookups() {
	const id = "targeted-search-related-lookups";
	const { doc, form } = searchApp(id, "Search by village", (uuid) => ({
		parentType: "household",
		properties: [],
		list: caseListOf([plainColumn(uuid("name"), "case_name", "Name")], {
			filter: eq(
				prop(
					"patient",
					"village",
					ancestorPath(relationStep("parent", "household")),
				),
				literal("north"),
			),
			searchInputs: [
				simpleSearchInputDef(
					uuid("input"),
					"case_name",
					"Name",
					"text",
					"case_name",
				),
			],
		}),
	}));
	return targetedDocument({
		id,
		rows: ["12, related lookups"],
		doc,
		expected: noteHeld(form),
	});
}
