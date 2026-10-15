/**
 * The lines for changes that write nothing: what a worker, an export or a
 * person sees differently with no stored change. One exported selection
 * function per document reason, each reading the migrated document, added by
 * the pull request that owns its reason. None of them is a step and none
 * changes the document.
 */

import type { BlueprintDoc, Field, Uuid } from "@/lib/domain";
import type { DocumentChange } from "./transform";

/** One no-write reason's selection over the migrated document. */
export interface BehaviorSelection {
	readonly reason: DocumentChange["reason"];
	select(target: BlueprintDoc): readonly DocumentChange[];
}

/** Every field of a form, in document order, containers' children included. */
function formFields(doc: BlueprintDoc, parent: Uuid): Field[] {
	return (doc.fieldOrder[parent] ?? []).flatMap((uuid) => {
		const field = doc.fields[uuid];
		return field === undefined ? [] : [field, ...formFields(doc, uuid)];
	});
}

/**
 * `validation-now-enforced`: each barcode and secret question that holds a
 * validation, which every export now writes as the question's constraint, so
 * workers see its message when an answer does not pass. Named by the field,
 * with its form's name and its kind.
 */
export const validationNowEnforced: BehaviorSelection = {
	reason: "validation-now-enforced",
	select(target) {
		return target.moduleOrder.flatMap((moduleUuid) =>
			(target.formOrder[moduleUuid] ?? []).flatMap((formUuid) => {
				const form = target.forms[formUuid];
				if (form === undefined) return [];
				return formFields(target, formUuid).flatMap(
					(field): DocumentChange[] =>
						(field.kind === "barcode" || field.kind === "secret") &&
						field.validate !== undefined
							? [
									{
										reason: "validation-now-enforced",
										entity: {
											type: "field",
											uuid: field.uuid,
											nameAtMigration: field.id,
										},
										detail: { form: form.name, kind: field.kind },
									},
								]
							: [],
				);
			}),
		);
	},
};

/**
 * `local-archive-changes`: one line for every app, naming the app, since
 * Nova cannot know which apps were installed from a downloaded file, and a
 * file downloaded from now on needs a newer CommCare than an earlier one did.
 */
export const localArchiveChanges: BehaviorSelection = {
	reason: "local-archive-changes",
	select(target) {
		return [
			{
				reason: "local-archive-changes",
				entity: { type: "app", nameAtMigration: target.appName },
			},
		];
	},
};

/** Every no-write document reason's selection, in the enum's order. */
export const BEHAVIOR_SELECTIONS: readonly BehaviorSelection[] = [
	validationNowEnforced,
	localArchiveChanges,
];

/** The no-write document lines for one migrated document. */
export function behaviorChanges(target: BlueprintDoc): DocumentChange[] {
	return BEHAVIOR_SELECTIONS.flatMap((selection) => selection.select(target));
}
