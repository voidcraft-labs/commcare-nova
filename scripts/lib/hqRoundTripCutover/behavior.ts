/**
 * The lines for changes that write nothing: what a worker, an export or a
 * person sees differently with no stored change. One exported selection
 * function per document reason, each reading the migrated document, added by
 * the pull request that owns its reason. None of them is a step and none
 * changes the document.
 */

import {
	type BlueprintDoc,
	caseScalarTextGuardIsChecked,
	caseSelectionCardinality,
	closeConditionPlacement,
	deriveCaseWriteInventory,
	type Field,
	type Form,
	type Module,
	type Uuid,
} from "@/lib/domain";
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

/** One form of the document with the menu that holds it. */
interface MenuForm {
	readonly form: Form;
	readonly module: Module;
}

/** Every form of the document, in menu order, each with its menu. */
function menuForms(doc: BlueprintDoc): MenuForm[] {
	return doc.moduleOrder.flatMap((moduleUuid) => {
		const module = doc.modules[moduleUuid];
		if (module === undefined) return [];
		return (doc.formOrder[moduleUuid] ?? []).flatMap((formUuid) => {
			const form = doc.forms[formUuid];
			return form === undefined ? [] : [{ form, module }];
		});
	});
}

/** The case actions a form's own questions write, in its menu's case type. */
function caseWriteBuckets({ form, module }: MenuForm, doc: BlueprintDoc) {
	return deriveCaseWriteInventory(
		doc,
		form.uuid,
		{ caseType: module.caseType },
		form.type,
	).buckets;
}

function formEntity(form: Form): DocumentChange["entity"] {
	return { type: "form", uuid: form.uuid, nameAtMigration: form.name };
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
 * The follow-up forms of single-select menus that write nothing: no
 * property, no child case and no worker-record write. A follow-up's update
 * writers are its preloads too, so none of those means no preload, and a
 * follow-up is not a close form. Each now carries a case block that touches
 * its case.
 */
function writeFreeFollowUps(doc: BlueprintDoc): MenuForm[] {
	return menuForms(doc).filter(
		(entry) =>
			entry.form.type === "followup" &&
			typeof entry.module.caseType === "string" &&
			entry.module.caseType.length > 0 &&
			caseSelectionCardinality(entry.module) === "single" &&
			caseWriteBuckets(entry, doc).every(
				(bucket) => bucket.kind === "primary" && bucket.writers.length === 0,
			),
	);
}

/**
 * `follow-up-now-touches-case`: each follow-up form of a single-select menu
 * that writes nothing. Its submissions now move its case's last-modified
 * date, which case update rules and data forwarding in HQ read. Named by the
 * form.
 */
export const followUpNowTouchesCase: BehaviorSelection = {
	reason: "follow-up-now-touches-case",
	select(target) {
		return writeFreeFollowUps(target).map(({ form }) => ({
			reason: "follow-up-now-touches-case",
			entity: formEntity(form),
		}));
	},
};

/**
 * `linked-follow-up-now-writes-case`: each after-submit link that names its
 * target's case by a written value (the link holds `datums`) and opens a
 * form `follow-up-now-touches-case` names. Opened by that link, the form now
 * writes to the case the link's value names. A link without `datums`
 * carries its source form's own case, which the line above covers. Named by
 * the target form, with the source form's name in `detail.source`.
 */
export const linkedFollowUpNowWritesCase: BehaviorSelection = {
	reason: "linked-follow-up-now-writes-case",
	select(target) {
		const touched = new Map(
			writeFreeFollowUps(target).map(({ form }) => [form.uuid, form]),
		);
		return menuForms(target).flatMap(({ form: source }) =>
			(source.formLinks ?? []).flatMap((link): DocumentChange[] => {
				if (link.datums === undefined || link.target.type !== "form") return [];
				const opened = touched.get(link.target.formUuid);
				return opened === undefined
					? []
					: [
							{
								reason: "linked-follow-up-now-writes-case",
								entity: formEntity(opened),
								detail: { source: source.name },
							},
						];
			}),
		);
	},
};

/**
 * `close-moves-to-save-to-case`: each close form of a single-select menu
 * whose condition HQ's Case Management tab cannot state. Its close is now a
 * Save to Case block in the form, so HQ's tab shows none and its next
 * publish asks about that plan feature. A close in a multi-select menu was
 * already a Save to Case close and gets no line. Named by the form.
 */
export const closeMovesToSaveToCase: BehaviorSelection = {
	reason: "close-moves-to-save-to-case",
	select(target) {
		return menuForms(target).flatMap(({ form, module }): DocumentChange[] =>
			form.type === "close" &&
			caseSelectionCardinality(module) === "single" &&
			closeConditionPlacement(target, form.uuid) === "save-to-case"
				? [{ reason: "close-moves-to-save-to-case", entity: formEntity(form) }]
				: [],
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

/**
 * The questions a form's basic actions read case names from, in the order
 * the form's case writes list them: a registration's create, a rename on a
 * follow-up or close form of a single-select menu, and each child case the
 * form creates. A multi-select menu's writes are in the form's source, not
 * basic actions, and the worker's own record keeps no name.
 */
function basicCaseNameFields(entry: MenuForm, doc: BlueprintDoc): Field[] {
	const { form, module } = entry;
	if (
		form.type !== "registration" &&
		caseSelectionCardinality(module) !== "single"
	)
		return [];
	return caseWriteBuckets(entry, doc)
		.filter((bucket) => bucket.kind !== "usercase")
		.flatMap((bucket) =>
			bucket.writers.flatMap((writer) => {
				const field =
					writer.property === "case_name"
						? doc.fields[writer.fieldUuid]
						: undefined;
				return field === undefined ? [] : [field];
			}),
		);
}

/**
 * `case-name-now-checked`: each form with a basic create or rename whose
 * case name comes from a question a worker answers. A blank name, or one
 * over 255 characters, now shows the worker the runtime's invalid-answer
 * message on that question. A Hidden Value source takes no check and gets
 * no line. Named by the form, with the id of its first such question in
 * `detail.question`.
 */
export const caseNameNowChecked: BehaviorSelection = {
	reason: "case-name-now-checked",
	select(target) {
		return menuForms(target).flatMap((entry): DocumentChange[] => {
			const field = basicCaseNameFields(entry, target).find((candidate) =>
				caseScalarTextGuardIsChecked(candidate.kind),
			);
			return field === undefined
				? []
				: [
						{
							reason: "case-name-now-checked",
							entity: formEntity(entry.form),
							detail: { question: field.id },
						},
					];
		});
	},
};

/** Every no-write document reason's selection, in the enum's order. */
export const BEHAVIOR_SELECTIONS: readonly BehaviorSelection[] = [
	validationNowEnforced,
	followUpNowTouchesCase,
	linkedFollowUpNowWritesCase,
	closeMovesToSaveToCase,
	localArchiveChanges,
	caseNameNowChecked,
];

/** The no-write document lines for one migrated document. */
export function behaviorChanges(target: BlueprintDoc): DocumentChange[] {
	return BEHAVIOR_SELECTIONS.flatMap((selection) => selection.select(target));
}
