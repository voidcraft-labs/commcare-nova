/** The add-ons an emitted app needs, one emitted application per predicate. Pure. */
import { describe, expect, it } from "vitest";
import type { HqApplication } from "@/lib/commcare";
import { addOnsNeededBy } from "../addOns";
import {
	type HqAdvancedModuleTree,
	type HqFormTree,
	type HqModuleTree,
	hqXPath,
	serializeHqApplication,
} from "../hqJson/xpath";
import {
	advancedFormShell,
	advancedModuleShell,
	applicationShell,
	detailColumn,
	detailPair,
	emptyAdvancedFormActions,
	emptyFormActions,
	formShell,
	ifCondition,
	moduleShell,
} from "../hqShells";
import { w } from "../xpath/wire/builders";

const PLAIN_FORM =
	'<h:html xmlns:h="http://www.w3.org/1999/xhtml" xmlns="http://www.w3.org/2002/xforms"><h:head><model><instance><data/></instance></model></h:head><h:body/></h:html>';
const ITEMSET_FORM =
	'<h:html xmlns:h="http://www.w3.org/1999/xhtml" xmlns="http://www.w3.org/2002/xforms"><h:head><model><instance><data/></instance></model></h:head><h:body><select1 ref="/data/choice"><itemset nodeset="instance(\'clinics\')/clinics/clinic"><label ref="name"/><value ref="id"/></itemset></select1></h:body></h:html>';

function form(edit: (form: HqFormTree) => void = () => {}): HqFormTree {
	const built = formShell(
		"f0",
		"Visit",
		"http://openrosa.org/formdesigner/add-ons",
		"none",
		emptyFormActions(),
		{},
		{},
		"default",
		null,
		[],
	);
	edit(built);
	return built;
}

function app(
	edit: (module: HqModuleTree) => void = () => {},
	attachment = PLAIN_FORM,
): HqApplication {
	const module = moduleShell(
		"m0",
		"Patients",
		"patient",
		[form()],
		detailPair([]),
		["en"],
		true,
	);
	edit(module);
	return serializeHqApplication(
		applicationShell(
			"Clinic",
			[module],
			{ "f0.xml": attachment },
			{ cloudcareEnabled: true },
		),
	);
}

describe("addOnsNeededBy", () => {
	it("needs none for an app that uses nothing an add-on shows", () => {
		expect(addOnsNeededBy(app())).toEqual([]);
	});

	it("needs each slug exactly where HQ's predicate, or Nova's for itemsets, says it is in use", () => {
		const column = (format: string, useXpathExpression = false) => ({
			...detailColumn(
				useXpathExpression ? hqXPath(w.context([w.step("status")])) : "status",
				"Status",
			),
			format: format as "plain",
		});
		const cases: [string, HqApplication][] = [
			["advanced_itemsets", app(() => {}, ITEMSET_FORM)],
			[
				"calc_xpaths",
				app((module) => {
					module.case_details = detailPair([], [column("plain", true)]);
				}),
			],
			[
				"case_list_menu_item",
				app((module) => {
					module.case_list.show = true;
				}),
			],
			[
				"conditional_enum",
				app((module) => {
					module.case_details = detailPair([column("conditional-enum")]);
				}),
			],
			[
				"conditional_form_actions",
				app((module) => {
					module.forms[0].actions.close_case.condition = ifCondition(
						"/data/done",
						"yes",
					);
				}),
			],
			[
				"display_conditions",
				app((module) => {
					module.forms[0].form_filter = hqXPath(
						w.eq(w.hqCase([w.step("status")]), w.str("open")),
						"case",
					);
				}),
			],
			[
				"display_conditions",
				app((module) => {
					module.module_filter = hqXPath(w.call("true"), "no-case");
				}),
			],
			[
				"enum_image",
				app((module) => {
					module.case_details = detailPair([column("enum-image")]);
				}),
			],
			[
				"register_from_case_list",
				app((module) => {
					module.case_list_form.form_id = "f9";
				}),
			],
			[
				"subcases",
				app((module) => {
					module.forms[0].actions.subcases = [
						{
							doc_type: "OpenSubCaseAction",
							case_type: "visit",
							name_update: {
								question_path: "/data/name",
								update_mode: "always",
							},
							reference_id: "",
							case_properties: {},
							repeat_context: "",
							relationship: "child",
							close_condition: ifCondition("/data/x", "y"),
							condition: ifCondition("/data/x", "y"),
						},
					];
				}),
			],
			[
				"submenus",
				app((module) => {
					module.root_module_id = "m9";
				}),
			],
		];
		for (const [slug, emitted] of cases)
			expect(addOnsNeededBy(emitted), slug).toEqual([slug]);
	});
});

/** An app of one advanced menu holding one advanced form with no load or create. */
function advancedApp(
	edit: (module: HqAdvancedModuleTree) => void = () => {},
): HqApplication {
	const module = advancedModuleShell(
		"m0",
		"Visits",
		"visit",
		[
			advancedFormShell(
				"f0",
				"Follow up",
				"http://openrosa.org/formdesigner/add-ons-advanced",
				emptyAdvancedFormActions(),
				{},
				{},
				"default",
				null,
				[],
			),
		],
		detailPair([detailColumn("name", "Name")]),
		"en",
		["en"],
		true,
	);
	edit(module);
	return serializeHqApplication(
		applicationShell(
			"Clinic",
			[module],
			{ "f0.xml": PLAIN_FORM },
			{ cloudcareEnabled: true },
		),
	);
}

describe("addOnsNeededBy over an advanced menu", () => {
	it("needs Child Cases and conditional actions for an advanced form whatever it holds, and nothing for the default product list", () => {
		// HQ's `subcases` and `_uses_conditional_form_actions` predicates hold
		// for every form that is not a `module_form`; the product list's one
		// column is `plain`.
		expect(addOnsNeededBy(advancedApp())).toEqual([
			"conditional_form_actions",
			"subcases",
		]);
	});

	it("needs the case list menu item where the advanced menu shows its case list", () => {
		expect(
			addOnsNeededBy(
				advancedApp((module) => {
					module.case_list.show = true;
				}),
			),
		).toEqual(["case_list_menu_item", "conditional_form_actions", "subcases"]);
	});

	it("reads the product list's formats for enum images, and only the case details for calculated columns", () => {
		const imageColumn = {
			...detailColumn("status", "Status"),
			format: "enum-image" as "plain",
		};
		const calculated = detailColumn(
			hqXPath(w.context([w.step("status")])),
			"Status",
		);
		expect(
			addOnsNeededBy(
				advancedApp((module) => {
					module.product_details = detailPair([imageColumn, calculated]);
				}),
			),
		).toEqual(["conditional_form_actions", "enum_image", "subcases"]);
	});
});
