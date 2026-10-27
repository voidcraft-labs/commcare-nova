/**
 * Defect 14, multi-select destinations: the witness for every after-submit
 * destination a menu offers, in menus that select several cases and menus
 * under them.
 *
 * Five menus and six follow-ups, so each destination has a form every
 * reader can open:
 *
 * - "Batches" (`m0`) selects several cases; its follow-up goes to `module`.
 * - "One sample" (`m1`) selects one case under `m0`; its follow-up goes to
 *   `firstMenu`, HQ's `root`.
 * - "Samples" (`m2`) selects one case; its first follow-up stores no
 *   destination, so it goes to `previous`, and its second goes to `module`.
 * - "Several samples" (`m3`) selects several cases under `m2`; its
 *   follow-up goes to `module`.
 * - "One more look" (`m4`) selects one case under `m2`; its follow-up goes
 *   to `parentMenu`, HQ's `parent_module`.
 *
 * Each destination is one HQ's form settings page offers the form
 * (`views/forms.py`, the `form_workflows` context), which Nova holds every
 * stored destination to (`lib/domain/postSubmit.ts::postSubmitDestinationsOffered`,
 * `POST_SUBMIT_NOT_OFFERED`): no `previous_screen` where the menu or its
 * parent selects several cases, which HQ's build refuses where exactly one
 * of them does (`mismatch multi select form links`). Android opens no menu
 * that selects several cases, nor one under it, so the second follow-up of
 * "Samples" is the one `module` form a device reads.
 *
 * Fixed values: each form's note holds the text the worker enters.
 */

import { buildDoc, f } from "@/lib/__tests__/docHelpers";
import {
	NEW_APP_SETTINGS,
	type PostSubmitDestination,
	plainColumn,
	proseText,
} from "@/lib/domain";
import { caseListOf, targetedDocument, targetedUuid } from "../build";
import { answerHeld } from "./echo";

const ID = "targeted-multi-select-destinations";
const uuid = (name: string) => targetedUuid(ID, name);

function followup(name: string, postSubmit?: PostSubmitDestination) {
	return {
		uuid: uuid(`form-${name}`),
		name: `Review ${name}`,
		type: "followup" as const,
		...(postSubmit !== undefined && { postSubmit }),
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
		// Choosing several cases runs in Web Apps alone.
		appSettings: { ...NEW_APP_SETTINGS, runsOnlyOn: "web-apps" },
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
				forms: [followup("batches", "module")],
			},
			{
				uuid: uuid("single-under-batches"),
				name: "One sample",
				caseType: "sample",
				caseListConfig: list("single-under-batches", false),
				forms: [followup("single-under-batches", "firstMenu")],
			},
			{
				uuid: uuid("samples"),
				name: "Samples",
				caseType: "sample",
				caseListConfig: list("samples", false),
				forms: [followup("samples"), followup("samples-again", "module")],
			},
			{
				uuid: uuid("batch-under-samples"),
				name: "Several samples",
				caseType: "sample",
				caseListConfig: list("batch-under-samples", true),
				forms: [followup("batch-under-samples", "module")],
			},
			{
				uuid: uuid("single-under-samples"),
				name: "One more look",
				caseType: "sample",
				caseListConfig: list("single-under-samples", false),
				forms: [followup("single-under-samples", "parentMenu")],
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
	nest("single-under-samples", "samples");
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
					"local",
					{ command: "m1-f0", caseId: "targeted-sample" },
				),
			],
		},
	});
}
