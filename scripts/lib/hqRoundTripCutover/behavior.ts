/**
 * The lines for changes that write nothing: what a worker, an export or a
 * person sees differently with no stored change. One exported selection
 * function per document reason, each reading the migrated document, added by
 * the pull request that owns its reason. None of them is a step and none
 * changes the document.
 */

import { moduleCaseListOrderPlan } from "@/lib/commcare/suite/case-list/orderPlanOptions";
import {
	type BlueprintDoc,
	type Column,
	caseListColumnTextShows,
	caseScalarTextGuardIsChecked,
	caseSelectionCardinality,
	closeConditionPlacement,
	deriveCaseWriteInventory,
	type Field,
	type Form,
	type Module,
	type Uuid,
} from "@/lib/domain";
import { collectAssetRefs } from "@/lib/domain/mediaRefs";
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

/** One menu of the document with its list. */
interface MenuList {
	readonly module: Module;
	readonly columns: readonly Column[];
	readonly tiled: boolean;
}

/** Every menu that holds a list, in menu order. */
function menuLists(doc: BlueprintDoc): MenuList[] {
	return doc.moduleOrder.flatMap((moduleUuid) => {
		const module = doc.modules[moduleUuid];
		const config = module?.caseListConfig;
		return module === undefined || config === undefined
			? []
			: [{ module, columns: config.columns, tiled: config.tile !== undefined }];
	});
}

function menuEntity(module: Module): DocumentChange["entity"] {
	return { type: "module", uuid: module.uuid, nameAtMigration: module.name };
}

/** A column's name: its header, or "a calculation", or its property. */
function columnName(column: Column): string {
	const header = column.header.trim();
	if (header.length > 0) return header;
	return column.kind === "calculated" ? "a calculation" : column.field;
}

function columnEntity(column: Column): DocumentChange["entity"] {
	return {
		type: "caseListColumn",
		uuid: column.uuid,
		nameAtMigration: columnName(column),
	};
}

/**
 * `case-list-order-changes`: each list whose order changes on some install
 * with no stored change, one line per list. The cause is the first that
 * holds of the field that takes the list's first rule, which in a list with
 * no authored rule is the field the implicit rule lands on
 * (`lib/domain/caseListOrder.ts`, rules 5 and 7), read from the plan every
 * reader builds, with media on:
 *
 *   - `id-mapping`: a shown ID mapping, now ordered by its table's order on
 *     every install;
 *   - `image-map`: a shown image map in an app with media, now ordered by
 *     its table's order in a downloaded app and Preview;
 *   - `interval`: a shown interval column, now ordered by the text it shows
 *     there;
 *   - `option-label`: a shown plain column over a select with options, now
 *     ordered by its labels there;
 *   - `unsorted`: anything else, in a list with no authored rule, which
 *     Preview now orders by the first column, and a downloaded app by date
 *     where that field is a date column.
 *
 * Each line names the menu, with the field's column kind in `detail.kind`;
 * the first four also name the column in `detail.column`. A list whose first rule lands on any other field, or on a
 * carrier, orders the same on every install before and after, and gets no
 * line.
 */
export const caseListOrderChanges: BehaviorSelection = {
	reason: "case-list-order-changes",
	select(target) {
		const mediaOn = collectAssetRefs(target).size > 0;
		return menuLists(target).flatMap(({ module }): DocumentChange[] => {
			const plan = moduleCaseListOrderPlan(module, target, true);
			const field = plan.fields.find(
				(candidate) => candidate.rule?.order === 1,
			);
			if (field === undefined) return [];
			const { column } = field;
			const cause = field.hidden
				? undefined
				: column.kind === "id-mapping"
					? "id-mapping"
					: column.kind === "image-map" && mediaOn
						? "image-map"
						: column.kind === "interval"
							? "interval"
							: field.key?.kind === "option-label"
								? "option-label"
								: undefined;
			if (cause !== undefined) {
				return [
					{
						reason: "case-list-order-changes",
						entity: menuEntity(module),
						detail: { cause, column: columnName(column), kind: column.kind },
					},
				];
			}
			if (field.rule?.implicit !== true) return [];
			return [
				{
					reason: "case-list-order-changes",
					entity: menuEntity(module),
					detail: { cause: "unsorted", kind: column.kind },
				},
			];
		});
	},
};

/**
 * `case-list-search-matches-hidden-fields`: each list with no tile layout
 * that holds a column hidden from Results. Such a column is a field of the
 * list on every path, so the list's search now matches it. Named by the
 * menu. A tile list's hidden column is no field, and its search does not.
 */
export const caseListSearchMatchesHiddenFields: BehaviorSelection = {
	reason: "case-list-search-matches-hidden-fields",
	select(target) {
		return menuLists(target).flatMap(
			({ module, columns, tiled }): DocumentChange[] =>
				!tiled && columns.some((column) => column.visibleInList === false)
					? [
							{
								reason: "case-list-search-matches-hidden-fields",
								entity: menuEntity(module),
							},
						]
					: [],
		);
	},
};

/**
 * `hidden-order-column-not-in-sort-menu`: each column hidden from Results
 * that carries an order rule, in any list. Android's Sort menu no longer
 * offers it in a downloaded app; the list's own order still follows it.
 * Named by the column, with the menu's name.
 */
export const hiddenOrderColumnNotInSortMenu: BehaviorSelection = {
	reason: "hidden-order-column-not-in-sort-menu",
	select(target) {
		return menuLists(target).flatMap(({ module, columns }) =>
			columns
				.filter(
					(column) =>
						column.visibleInList === false && column.sort !== undefined,
				)
				.map(
					(column): DocumentChange => ({
						reason: "hidden-order-column-not-in-sort-menu",
						entity: columnEntity(column),
						detail: { menu: module.name },
					}),
				),
		);
	},
};

/**
 * `record-id-column-now-shows`: each plain, phone or image-map column over
 * `case_id` that reaches a screen (`caseListColumnTextShows`). Each was
 * blank in an app installed from CommCare HQ, and from the next publish
 * shows the case's ID, or the image mapped to it. An ID mapping and a link
 * over `case_id` already showed. Named by the column, with the menu's name
 * and `detail.kind`.
 */
export const recordIdColumnNowShows: BehaviorSelection = {
	reason: "record-id-column-now-shows",
	select(target) {
		return menuLists(target).flatMap(({ module, columns }) =>
			columns.flatMap((column): DocumentChange[] =>
				(column.kind === "plain" ||
					column.kind === "phone" ||
					column.kind === "image-map") &&
				column.field === "case_id" &&
				caseListColumnTextShows(column)
					? [
							{
								reason: "record-id-column-now-shows",
								entity: columnEntity(column),
								detail: { menu: module.name, kind: column.kind },
							},
						]
					: [],
			),
		);
	},
};

/** Every no-write document reason's selection, in the enum's order. */
export const BEHAVIOR_SELECTIONS: readonly BehaviorSelection[] = [
	validationNowEnforced,
	followUpNowTouchesCase,
	linkedFollowUpNowWritesCase,
	closeMovesToSaveToCase,
	caseListOrderChanges,
	caseListSearchMatchesHiddenFields,
	hiddenOrderColumnNotInSortMenu,
	recordIdColumnNowShows,
	localArchiveChanges,
	caseNameNowChecked,
];

/** The no-write document lines for one migrated document. */
export function behaviorChanges(target: BlueprintDoc): DocumentChange[] {
	return BEHAVIOR_SELECTIONS.flatMap((selection) => selection.select(target));
}
