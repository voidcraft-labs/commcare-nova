/**
 * Step `empty-forms`: adds one Label to each form that holds fields and no
 * question. HQ's build refuses a form whose fields are all groups, repeats
 * or sections as a blank form, and the validator now refuses it
 * (`EMPTY_FORM`; part 08 of step 2's plan, Finding 31). A question here is
 * what the rule counts: any field, at any depth, that is not a group, a
 * repeat or a section, a Label and a Hidden Value included.
 *
 * The Label goes at the form's root, or inside its first section where the
 * form is sectioned, since a sectioned root holds only sections. Its id is
 * `note`, suffixed until free among its siblings (at the root, the form's
 * Connect block ids among them), its text "This form has no
 * questions yet.", and its uuid UUIDv5 of the form's uuid and the name
 * `empty-form-note`, so the rehearsal and the execute run write the same
 * target. A Label is the smallest content that satisfies both rules, and
 * nothing is removed.
 *
 * One `empty-form-label-added` line per form, naming it.
 */

import { v5 as uuidv5 } from "uuid";
import { asUuid } from "@/lib/domain";
import { suffixUntilFree } from "@/lib/domain/idSlug";
import type { JsonRecord, RawDocument } from "../oldShape";
import type { CutoverStep, DocumentChange } from "../transform";
import { rawRootNames, rawText } from "./relativePaths";

export const EMPTY_FORM_NOTE_NAME = "empty-form-note";
export const EMPTY_FORM_NOTE_TEXT = "This form has no questions yet.";

const CONTAINERS: ReadonlySet<string> = new Set(["group", "repeat", "section"]);

function holdsQuestion(document: RawDocument, parent: string): boolean {
	return (document.fieldOrder[parent] ?? []).some((uuid) => {
		const field = document.fields[uuid];
		if (field === undefined) return false;
		return (
			!CONTAINERS.has(rawText(field.kind)) || holdsQuestion(document, uuid)
		);
	});
}

export const emptyFormsStep: CutoverStep = {
	id: "empty-forms",
	apply(document) {
		const changes: DocumentChange[] = [];
		const fields = document.fields as Record<string, JsonRecord>;
		const fieldOrder = document.fieldOrder as Record<string, string[]>;
		for (const moduleUuid of document.moduleOrder) {
			for (const formUuid of document.formOrder[moduleUuid] ?? []) {
				const form = document.forms[formUuid];
				const roots = document.fieldOrder[formUuid] ?? [];
				if (form === undefined || roots.length === 0) continue;
				if (holdsQuestion(document, formUuid)) continue;
				const [first] = roots;
				const parent =
					first !== undefined && document.fields[first]?.kind === "section"
						? first
						: formUuid;
				const siblings = new Set([
					...(document.fieldOrder[parent] ?? []).map((uuid) =>
						rawText(document.fields[uuid]?.id),
					),
					...(parent === formUuid
						? rawRootNames(document, formUuid).connectIds
						: []),
				]);
				const uuid = uuidv5(EMPTY_FORM_NOTE_NAME, formUuid);
				fields[uuid] = {
					uuid,
					id: suffixUntilFree("note", siblings),
					kind: "label",
					label: { parts: [{ kind: "text", text: EMPTY_FORM_NOTE_TEXT }] },
				};
				fieldOrder[parent] = [...(fieldOrder[parent] ?? []), uuid];
				changes.push({
					reason: "empty-form-label-added",
					entity: {
						type: "form",
						uuid: asUuid(formUuid),
						nameAtMigration: rawText(form.name),
					},
				});
			}
		}
		return changes;
	},
};
