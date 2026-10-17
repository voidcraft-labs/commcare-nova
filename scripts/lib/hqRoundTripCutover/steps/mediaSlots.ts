/**
 * Step `media-slots`: three media slots leave the model. No CommCare runtime
 * draws media on a hint, a validation message, or a group's or repeat's label
 * (Android, Formplayer and the Web Apps client; part 08 of step 2's plan,
 * "Defect 16: three media slots leave the model"), so the strict field
 * schemas refuse `hint_media`, `validate_msg_media`, and `label_media` on a
 * group or a repeat. The step deletes each from every field that holds it.
 *
 * It deletes no asset: the library is the Project's, another app may use the
 * file, and the cutover rebuilds the app's media reference projection from
 * the target document, so the deletion guard stops counting these references
 * and a person may remove a file nothing else uses.
 *
 * One `media-slot-removed` line per media kind a removed slot held, naming
 * the field, with its form's name, the slot (`hint`, `validation-message`,
 * `group-title` or `repeat-title`) and the media kind (`image`, `audio` or
 * `video`).
 */

import { asUuid } from "@/lib/domain";
import type { Json, JsonRecord, RawDocument } from "../oldShape";
import type { CutoverStep, DocumentChange } from "../transform";
import { writableRecord } from "./caseLists";
import { fieldUuidsUnder, isRecord, rawText } from "./relativePaths";

/** The media kinds a `Media` bundle holds, in the order a line names them. */
const MEDIA_KINDS = ["image", "audio", "video"] as const;

/** The notice's name for each removed slot of a field of `kind`, by its key. */
function removedSlots(kind: string): readonly (readonly [string, string])[] {
	const slots: [string, string][] = [
		["hint_media", "hint"],
		["validate_msg_media", "validation-message"],
	];
	if (kind === "group") slots.push(["label_media", "group-title"]);
	if (kind === "repeat") slots.push(["label_media", "repeat-title"]);
	return slots;
}

/** Every field uuid in document order (menu, form, tree), then any field no form holds. */
function fieldsInOrder(
	document: RawDocument,
): readonly (readonly [string, string | undefined])[] {
	const ordered: [string, string | undefined][] = [];
	const seen = new Set<string>();
	for (const moduleUuid of document.moduleOrder) {
		for (const formUuid of document.formOrder[moduleUuid] ?? []) {
			for (const fieldUuid of fieldUuidsUnder(document, formUuid)) {
				if (seen.has(fieldUuid)) continue;
				seen.add(fieldUuid);
				ordered.push([fieldUuid, formUuid]);
			}
		}
	}
	for (const fieldUuid of Object.keys(document.fields).sort()) {
		if (!seen.has(fieldUuid)) ordered.push([fieldUuid, undefined]);
	}
	return ordered;
}

export const mediaSlotsStep: CutoverStep = {
	id: "media-slots",
	apply(document) {
		const changes: DocumentChange[] = [];
		for (const [fieldUuid, formUuid] of fieldsInOrder(document)) {
			const field = document.fields[fieldUuid];
			if (field === undefined) continue;
			for (const [key, slot] of removedSlots(rawText(field.kind))) {
				if (!Object.hasOwn(field, key)) continue;
				const bundle: Json = field[key];
				delete writableRecord(field)[key];
				if (!isRecord(bundle)) continue;
				const form: JsonRecord | undefined =
					formUuid === undefined ? undefined : document.forms[formUuid];
				for (const media of MEDIA_KINDS) {
					if (rawText(bundle[media]) === "") continue;
					changes.push({
						reason: "media-slot-removed",
						entity: {
							type: "field",
							uuid: asUuid(fieldUuid),
							nameAtMigration: rawText(field.id),
						},
						detail: {
							...(form !== undefined && { form: rawText(form.name) }),
							slot,
							media,
						},
					});
				}
			}
		}
		return changes;
	},
};
