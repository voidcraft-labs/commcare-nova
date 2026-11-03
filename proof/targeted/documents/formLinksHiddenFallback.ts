/**
 * Defect 26: a form whose links HQ's form settings page once could not show
 * whole, in the shape step 5's migration gives it, which the page now keeps.
 *
 * HQ's page lists only the targets it offers
 * (`views/forms.py::_get_linkable_forms_context`: a menu only when it is
 * top-level or its parent's case type matches the form's menu's parent's),
 * keeps only the links whose target it lists
 * (`static/app_manager/js/forms/bootstrap3/form_workflow.js`, `FormWorkflow`),
 * and offers no previous screen as the fallback of a form in a multi-select
 * menu (`views/forms.py::get_form_view_context`, `form_workflows`). Before
 * step 5 this form linked to the nested Ponds menu beside the top-level Sites
 * and fell back to the previous screen, so the form settings save dropped the
 * one link and cleared the fallback, which changed the stack HQ builds
 * (`suite_xml/post_process/workflow.py::_get_static_stack_frame`); the
 * control of this document's id keeps those bytes and every symptom.
 *
 * Here the form holds what `lib/doc/formLinkSemanticsMap.ts::mapFormLinkSemantics`
 * writes of it: the link to Ponds, which HQ does not offer from top-level
 * Frogs, opens Sites, the menu that holds it (L4); the second link's
 * condition holds the negation of the first's (L1); and the fallback, the
 * previous screen this menu does not offer, is the menu itself (L3, then
 * L6). Each link is one HQ's page lists and the otherwise one it offers, so
 * the form settings save changes nothing.
 *
 * Fixed values: the form's note holds the text the worker enters
 * (`./echo.ts`).
 */

import { buildDoc, f } from "@/lib/__tests__/docHelpers";
import { NEW_APP_SETTINGS, plainColumn, proseText } from "@/lib/domain";
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
							condition:
								"#user/username = 'bea' and not(#user/username = 'alice')",
							target: {
								type: "module" as const,
								moduleUuid: uuid("module-Sites"),
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
		// Choosing several cases runs in Web Apps alone.
		appSettings: { ...NEW_APP_SETTINGS, runsOnlyOn: "web-apps" },
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
	const frogs = doc.forms[source];
	if (frogs === undefined) throw new Error("No Frogs form.");
	doc.forms[source] = {
		...frogs,
		otherwise: { kind: "destination", destination: "module" },
	};
	return targetedDocument({
		id: ID,
		rows: ["26"],
		doc,
		expected: {
			intent: [answerHeld("note-held", source, "/data/note", "fed", "A")],
		},
	});
}
