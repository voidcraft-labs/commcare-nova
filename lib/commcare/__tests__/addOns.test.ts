/** The add-ons an emitted app needs, one emitted application per predicate. Pure. */
import { describe, expect, it } from "vitest";
import type { HqApplication } from "@/lib/commcare";
import { addOnsNeededBy } from "../addOns";
import {
	applicationShell,
	detailColumn,
	detailPair,
	emptyFormActions,
	formShell,
	ifCondition,
	moduleShell,
} from "../hqShells";
import type { HqForm, HqModule } from "../types";

const PLAIN_FORM =
	'<h:html xmlns:h="http://www.w3.org/1999/xhtml" xmlns="http://www.w3.org/2002/xforms"><h:head><model><instance><data/></instance></model></h:head><h:body/></h:html>';
const ITEMSET_FORM =
	'<h:html xmlns:h="http://www.w3.org/1999/xhtml" xmlns="http://www.w3.org/2002/xforms"><h:head><model><instance><data/></instance></model></h:head><h:body><select1 ref="/data/choice"><itemset nodeset="instance(\'clinics\')/clinics/clinic"><label ref="name"/><value ref="id"/></itemset></select1></h:body></h:html>';

function form(edit: (form: HqForm) => void = () => {}): HqForm {
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
	edit: (module: HqModule) => void = () => {},
	attachment = PLAIN_FORM,
): HqApplication {
	const module = moduleShell(
		"m0",
		"Patients",
		"patient",
		[form()],
		detailPair([]),
		["en"],
	);
	edit(module);
	return applicationShell("Clinic", [module], { "f0.xml": attachment });
}

describe("addOnsNeededBy", () => {
	it("needs none for an app that uses nothing an add-on shows", () => {
		expect(addOnsNeededBy(app())).toEqual([]);
	});

	it("needs each slug exactly where HQ's predicate, or Nova's for itemsets, says it is in use", () => {
		const column = (format: string, useXpathExpression = false) => ({
			...detailColumn("status", "Status"),
			format: format as "plain",
			useXpathExpression,
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
					module.forms[0].form_filter = "#case/status = 'open'";
				}),
			],
			[
				"display_conditions",
				app((module) => {
					module.module_filter = "true()";
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
