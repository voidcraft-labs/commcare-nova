/**
 * Searches whose symptoms show where HQ reads a search's configuration: its
 * Case List page, its Web Apps workflow selector, and its search endpoint.
 *
 * - `targeted-search-default-filter-name` (defect 14, search settings): a
 *   search input named `_xpath_query`, the property every default filter
 *   Nova writes is named (`lib/commcare/hqJson/caseList.ts::projectDefaultProperties`),
 *   beside a case list filter, which Nova writes as one. HQ's Case List page
 *   flags a search property that shares a default property's name
 *   (`details/case_claim.js::commonProperties`) and refuses to save.
 * - `targeted-sync-on-form-entry` (defect 20, sync on form entry): a
 *   list-first menu that offers search, whose follow-up form loads the case
 *   the worker picks, published to a project space with sync cases on form
 *   entry on. HQ's build gives the form's entry a claim of the picked case
 *   (`suite_xml/post_process/remote_requests.py`, the setting read through
 *   `case_search_sync_cases_on_form_entry_enabled_for_domain`), so Core's
 *   session asks for a sync before it opens the form
 *   (`CommCareSession.getNeededData`), which Nova's local archive never asks.
 * - `targeted-list-first-web-apps` (defect 21): a list-first menu that
 *   offers search, in an app with Web Apps on, so HQ's Case List page shows
 *   its search workflow selector (`views/modules.py::get_module_view_context`,
 *   `show_search_workflow`: the app's `cloudcare_enabled`, the `CLOUDCARE`
 *   privilege and `SYNC_SEARCH_CASE_CLAIM`), which offers no list-first
 *   choice, and the save turns the menu search-first.
 * - `targeted-search-hq-compile` (defects 6 CSQL, 14 reserved input
 *   names): default filters that order a time property and ask whether
 *   `date_opened` is blank, and inputs named `include_closed` and `owner_id`
 *   that reach HQ's search as their own keys. HQ's CSQL compiler refuses
 *   both filters (`case_search/xpath_functions/comparison.py`), and HQ's
 *   search reads the two inputs as configuration and as an owner filter, not
 *   as the properties they name
 *   (`case_search/models.py::extract_search_request_config`,
 *   `case_search/utils.py::_apply_filter`).
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
	and,
	eq,
	gt,
	isBlank,
	literal,
	prop,
	relationStep,
	timeLiteral,
} from "@/lib/domain/predicate";
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
						],
					},
				],
			},
		],
	});
	return { doc, form };
}

function noteHeld(form: ReturnType<typeof targetedUuid>) {
	return { intent: [answerHeld("note-held", form, "/data/note", "seen")] };
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
					"_xpath_query",
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

export function syncOnFormEntry() {
	const id = "targeted-sync-on-form-entry";
	const { doc, form } = searchApp(id, "Claimed visits", (uuid) => ({
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
		rows: ["20, sync on form entry (the session)"],
		doc,
		expected: noteHeld(form),
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

export function searchHqCompile() {
	const id = "targeted-search-hq-compile";
	const { doc, form } = searchApp(id, "Search HQ compiles", (uuid) => ({
		properties: [
			{ name: "visit_time", data_type: "time" },
			{ name: "include_closed" },
		],
		list: caseListOf([plainColumn(uuid("name"), "case_name", "Name")], {
			filter: and(
				gt(prop("patient", "visit_time"), timeLiteral("09:00:00")),
				isBlank(prop("patient", "date_opened")),
			),
			searchInputs: [
				simpleSearchInputDef(
					uuid("include-closed"),
					"include_closed",
					"Include closed",
					"text",
					"include_closed",
				),
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
