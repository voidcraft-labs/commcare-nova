/**
 * Defect 26: a form whose links HQ's form settings page cannot show whole.
 *
 * HQ's page lists only the targets it offers
 * (`views/forms.py::_get_linkable_forms_context`: a menu only when it is
 * top-level or its parent's case type matches the form's menu's parent's),
 * keeps only the links whose target it lists
 * (`static/app_manager/js/forms/bootstrap3/form_workflow.js`, `FormWorkflow`),
 * and offers no previous screen as the fallback of a form in a multi-select
 * menu (`views/forms.py::get_form_view_context`, `form_workflows`). So the
 * form settings save drops the link to the nested menu beside the link to
 * the top-level one, and clears the fallback, which changes the stack HQ
 * builds (`suite_xml/post_process/workflow.py::_get_static_stack_frame`).
 *
 * Fixed values: the form's note holds the text the worker enters
 * (`./echo.ts`).
 */

import { buildDoc, f } from "@/lib/__tests__/docHelpers";
import { plainColumn, proseText } from "@/lib/domain";
import { caseListOf, targetedDocument, targetedUuid } from "../build";
import { answerHeld } from "./echo";

const ID = "targeted-form-links-hidden-and-fallback";
const uuid = (name: string) => targetedUuid(ID, name);

function caseModule(
	name: string,
	caseType: string,
	options: {
		readonly multiple?: boolean;
		readonly links?: boolean;
	} = {},
) {
	return {
		uuid: uuid(`module-${name}`),
		name,
		caseType,
		caseListConfig: caseListOf(
			[plainColumn(uuid(`column-${name}`), "case_name", "Name")],
			options.multiple === true
				? { selection: { kind: "multiple" as const, maximum: 5 } }
				: {},
		),
		forms: [
			{
				uuid: uuid(`form-${name}`),
				name: `Review ${name}`,
				type: "followup" as const,
				...(options.links === true && {
					postSubmit: "previous" as const,
					formLinks: [
						{
							uuid: uuid("link-sites"),
							condition: "#user/username = 'alice'",
							target: {
								type: "module" as const,
								moduleUuid: uuid("module-Sites"),
							},
						},
						{
							uuid: uuid("link-ponds"),
							condition: "#user/username = 'bea'",
							target: {
								type: "module" as const,
								moduleUuid: uuid("module-Ponds"),
							},
						},
					],
				}),
				fields: [
					f({
						kind: "text",
						uuid: uuid(`note-${name}`),
						id: "note",
						label: proseText("Note"),
					}),
				],
			},
			// A link target lands on its menu's form list, which a registration
			// form beside the follow-up gives it.
			...(options.links === true
				? []
				: [
						{
							uuid: uuid(`register-${name}`),
							name: `Register ${name}`,
							type: "registration" as const,
							fields: [
								f({
									kind: "text",
									uuid: uuid(`name-${name}`),
									id: "name",
									label: proseText("Name"),
									caseWrite: { caseType, property: "case_name" },
								}),
							],
						},
					]),
		],
	};
}

export function formLinksHiddenFallback() {
	const source = uuid("form-Frogs");
	const doc = buildDoc({
		appId: ID,
		appName: "Pond care",
		caseTypes: ["site", "pond", "frog"].map((name) => ({
			name,
			properties: [{ name: "case_name", label: proseText("Name") }],
		})),
		modules: [
			caseModule("Sites", "site"),
			caseModule("Ponds", "pond"),
			caseModule("Frogs", "frog", { multiple: true, links: true }),
		],
	});
	const ponds = doc.modules[uuid("module-Ponds")];
	if (ponds === undefined) throw new Error("No Ponds menu.");
	ponds.parentModuleUuid = uuid("module-Sites");
	return targetedDocument({
		id: ID,
		rows: ["26"],
		doc,
		expected: {
			intent: [answerHeld("note-held", source, "/data/note", "fed")],
		},
	});
}
