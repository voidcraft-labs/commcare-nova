/**
 * Defect 14, multi-select destinations: a menu of single cases nested under a
 * menu of several, and a menu of several nested under a menu of one, each
 * with a follow-up form that returns to the previous screen.
 *
 * Nova emits `previous_screen` for a follow-up form wherever it is
 * (`lib/domain/forms.ts::defaultPostSubmit`, `lib/commcare/session.ts`), and
 * HQ's build refuses it where exactly one of the menu and its parent is
 * multi-select (`helpers/validators.py::FormBaseValidator.validate_for_module`,
 * `mismatch multi select form links`), so HQ cannot build the app; the form
 * settings save refuses the destination as well, since the page offers no
 * previous screen there (`views/forms.py::get_form_view_context`).
 *
 * Fixed values: each form's note holds the text the worker enters.
 */

import { buildDoc, f } from "@/lib/__tests__/docHelpers";
import { plainColumn, proseText } from "@/lib/domain";
import { caseListOf, targetedDocument, targetedUuid } from "../build";
import { answerHeld } from "./echo";

const ID = "targeted-multi-select-destinations";
const uuid = (name: string) => targetedUuid(ID, name);

function followup(name: string) {
	return {
		uuid: uuid(`form-${name}`),
		name: `Review ${name}`,
		type: "followup" as const,
		fields: [
			f({
				kind: "text",
				uuid: uuid(`note-${name}`),
				id: "note",
				label: proseText("Note"),
			}),
		],
	};
}

function list(name: string, multiple: boolean) {
	return caseListOf(
		[plainColumn(uuid(`column-${name}`), "case_name", "Name")],
		{
			...(multiple && { selection: { kind: "multiple" as const, maximum: 5 } }),
		},
	);
}

export function multiSelectDestinations() {
	const doc = buildDoc({
		appId: ID,
		appName: "Batch reviews",
		caseTypes: [
			{
				name: "sample",
				properties: [{ name: "case_name", label: proseText("Name") }],
			},
		],
		modules: [
			{
				uuid: uuid("batches"),
				name: "Batches",
				caseType: "sample",
				caseListConfig: list("batches", true),
				forms: [followup("batches")],
			},
			{
				uuid: uuid("single-under-batches"),
				name: "One sample",
				caseType: "sample",
				caseListConfig: list("single-under-batches", false),
				forms: [followup("single-under-batches")],
			},
			{
				uuid: uuid("samples"),
				name: "Samples",
				caseType: "sample",
				caseListConfig: list("samples", false),
				forms: [followup("samples")],
			},
			{
				uuid: uuid("batch-under-samples"),
				name: "Several samples",
				caseType: "sample",
				caseListConfig: list("batch-under-samples", true),
				forms: [followup("batch-under-samples")],
			},
		],
	});
	const nest = (child: string, parent: string) => {
		const module = doc.modules[uuid(child)];
		if (module === undefined) throw new Error(`No module ${child}.`);
		module.parentModuleUuid = uuid(parent);
	};
	nest("single-under-batches", "batches");
	nest("batch-under-samples", "samples");
	return targetedDocument({
		id: ID,
		rows: ["14, multi-select destinations"],
		doc,
		expected: {
			intent: [
				answerHeld(
					"note-held",
					uuid("form-single-under-batches"),
					"/data/note",
					"checked",
				),
			],
		},
	});
}
