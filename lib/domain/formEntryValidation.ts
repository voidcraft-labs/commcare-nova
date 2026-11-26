import {
	formCaseSelections,
	menuEmittedAdvanced,
	ownFormSelectionIndex,
} from "./advancedEntryDatums";
import { advancedKindBlockers } from "./advancedModule";
import type { BlueprintDoc } from "./blueprint";
import type { LookupTypeIndex } from "./expression/context";
import { formStructure } from "./expression/formStructure";
import type { Expression } from "./expression/types";
import { walkExpressionTerms } from "./expression/walk";
import { openingAssignmentSource } from "./formOpeningAssignments";
import { type Form, usesFormEntryActions } from "./forms";
import { USERCASE_CASE_TYPE } from "./usercase";
import type { Uuid } from "./uuid";

/** Selection and calculated-value expressions may refer only to a completed
 * prefix: the worker hasn't supplied a later case or opened the form yet. */
export function validateFormEntryCases(
	doc: BlueprintDoc,
	form: Form,
	tables?: LookupTypeIndex,
): string[] {
	const errors: string[] = [];
	const selected = new Set<Uuid>();
	const computed = new Set<Uuid>();
	const supplied = new Set<string>();
	if (
		!form.shadowOf &&
		!form.caseSelections &&
		!form.computedDatums?.length &&
		!form.openingAssignments?.length
	)
		return [];
	const rows = form.caseSelections ?? formCaseSelections(doc, form.uuid);
	const types = new Set([
		USERCASE_CASE_TYPE,
		...(doc.caseTypes ?? []).map((type) => type.name),
		...Object.values(doc.modules).map((module) => module.caseType),
	]);
	const menu = doc.moduleOrder.find((owner) =>
		doc.formOrder[owner]?.includes(form.uuid),
	);
	const note = (message: string) =>
		errors.push(`In “${form.name}”, ${message}`);
	if (form.shadowOf) {
		const shared = form.shadowOf;
		const parent = doc.forms[shared.form];
		if (!parent || parent.shadowOf) {
			note(
				"the form this entry opens is missing or is itself a shared entry. You can choose an ordinary form or remove this entry.",
			);
			return errors;
		}
		const parentMenu = doc.moduleOrder.find((module) =>
			doc.formOrder[module]?.includes(parent.uuid),
		);
		if (!parentMenu || !menuEmittedAdvanced(doc, parentMenu))
			note(
				`“${parent.name}” needs to be in a menu with advanced form settings before it can be shared. You can choose another form or change its menu first.`,
			);
		if (!menu || !menuEmittedAdvanced(doc, menu))
			note(
				"this entry needs a menu with advanced form settings. You can change its menu or move the entry.",
			);
		if (
			form.caseSelections ||
			form.caseOperations ||
			form.openingAssignments ||
			form.heldBasicOpening ||
			form.ownClosePlacement ||
			form.openCondition ||
			form.closeCondition ||
			form.connect ||
			form.plainText ||
			doc.fieldOrder[form.uuid]?.length
		)
			note(
				`its questions and record changes belong to “${parent.name}”. You can edit them there.`,
			);
		if (form.captureLocation)
			note(
				`whether it asks for the device location follows “${parent.name}”. You can set location there.`,
			);
		if (form.type !== parent.type)
			note(
				`its form type follows “${parent.name}”. You can apply the same type to each entry sharing that form.`,
			);
		const parentRows = formCaseSelections(doc, parent.uuid);
		const identities = new Set(parentRows.map((row) => row.uuid));
		const tags = new Set(parentRows.map((row) => row.tag));
		for (const row of shared.selections) {
			if (row.kind === "replace" && !identities.has(row.selection))
				note(
					`a replacement points to a choice “${parent.name}” no longer has. You can choose another record or remove that replacement.`,
				);
			if (row.kind === "add" && tags.has(row.tag))
				note(
					`“${row.name}” uses a shared record choice’s name on the device. You can replace the shared choice or give your extra choice a different saved name.`,
				);
		}
	}
	if (
		form.caseSelections !== undefined &&
		(form.type === "followup" || form.type === "close") &&
		ownFormSelectionIndex(doc, form.uuid) === undefined
	)
		note(
			"its own record needs a choice from a list of its menu’s record type. You can add that choice or change the form type and its record changes together.",
		);
	if (
		menu &&
		(form.shadowOf !== undefined || usesFormEntryActions(form)) &&
		advancedKindBlockers(doc, menu).length
	)
		note(
			"its menu settings conflict with this form’s opening choices. You can review the menu’s record selection settings.",
		);
	const checkInput = (name: string, expr: Expression) => {
		walkExpressionTerms(expr, (term) => {
			if (term.kind === "session-datum") {
				const ref = term.datum;
				if (
					(ref.kind === "form-selection" && !selected.has(ref.selection)) ||
					(ref.kind === "entry-value" && !computed.has(ref.datum))
				)
					note(
						`“${name}” needs a value this form has yet to open with. You can place its source earlier or choose another value.`,
					);
			}
		});
	};
	let previousRow: (typeof rows)[number] | undefined;
	for (const row of rows) {
		const src = row.source;
		if (!types.has(row.caseType))
			note(
				`“${row.name}” needs a record type in this app. You can choose an existing record type.`,
			);
		if (supplied.has(`case_id_${row.tag}`))
			note(
				`“${row.name}” shares its saved record tag with another choice. Each choice needs its own tag.`,
			);
		if (
			src.kind === "choose" &&
			doc.modules[src.module]?.caseType !== row.caseType
		)
			note(
				`“${row.name}” needs a list of ${row.caseType} records. You can choose a list that shows this type.`,
			);
		if (
			src.kind === "choose" &&
			typeof src.under?.relationship === "object" &&
			!formStructure(doc, form.shadowOf?.form ?? form.uuid)?.fields.has(
				src.under.relationship.question,
			)
		)
			note(
				`“${row.name}” needs a question from this form for its saved connection kind. You can choose another question or a fixed connection kind.`,
			);
		const parent =
			src.kind === "choose"
				? src.under?.selection
				: src.kind === "index"
					? src.selection
					: undefined;
		if (parent !== undefined && !selected.has(parent))
			note(
				`“${row.name}” needs an earlier record to follow its connection. You can place that record first.`,
			);
		// CommCare HQ's form builder narrows a list choice only by the record
		// chosen right before it (`advanced/actions.js`, `subcase.write`:
		// `load_update_cases()[index - 1]`), so it can make and keep no other.
		else if (
			src.kind === "choose" &&
			src.under !== undefined &&
			src.under.selection !== previousRow?.uuid
		)
			note(
				`“${row.name}” is narrowed by a record chosen before the one right above it. You can place “${rows.find((one) => one.uuid === src.under?.selection)?.name ?? "that record"}” right before it, or narrow it by the record right above it.`,
			);
		if (src.kind === "worker-record" && row.caseType !== USERCASE_CASE_TYPE)
			note(
				`“${row.name}” uses the worker’s own record. You can choose the worker record type for it.`,
			);
		if (
			src.kind === "table" &&
			tables !== undefined &&
			!tables.get(src.table)?.has(src.column)
		)
			note(
				`“${row.name}” needs a column in a table in this Project. You can choose another table column.`,
			);
		if (
			src.kind === "worker-data" &&
			src.property.kind === "session-user-property" &&
			!doc.userProperties?.[src.property.userPropertyUuid]
		)
			note(
				`“${row.name}” needs a worker property that this app has. You can choose another worker property.`,
			);
		if (src.kind === "expression") checkInput(row.name, src.value);
		selected.add(row.uuid);
		supplied.add(`case_id_${row.tag}`);
		previousRow = row;
	}
	const destinations = new Set<string>();
	const fields = formStructure(doc, form.uuid)?.fields;
	let previousSource = -1;
	for (const assignment of form.openingAssignments ?? []) {
		const destination = fields?.get(assignment.field);
		if (
			!destination ||
			["group", "repeat", "section"].includes(destination.kind)
		)
			note(
				"a starting record value needs a question in this form. You can choose another question.",
			);
		const source = assignment.source;
		const { rank, key: sourceKey } = openingAssignmentSource(
			doc,
			form.uuid,
			source,
		);
		if (
			rank < 0 ||
			(source.kind === "own" &&
				form.type !== "followup" &&
				form.type !== "close") ||
			(source.kind === "worker-record" &&
				form.caseSelections &&
				!rows.some((row) => row.source.kind === "worker-record"))
		)
			note(
				"a starting value needs a record supplied by this form. You can choose an opening record or the worker’s record.",
			);
		const physical = formCaseSelections(doc, form.uuid)[rank];
		if (
			assignment.via?.length &&
			menu &&
			menuEmittedAdvanced(doc, menu) &&
			physical?.source.kind === "choose" &&
			physical.source.under
		)
			note(
				"this record choice already follows another record's connection. You can copy a property directly from this record or use its connected record as a separate opening choice.",
			);
		if (rank < previousSource)
			note(
				"starting record values follow the order of the records that supply them. You can move this value beside the others from its record.",
			);
		const key = `${sourceKey}:${assignment.field}`;
		if (destinations.has(key))
			note(
				"one record can fill a question once when the form opens. You can update the existing starting value.",
			);
		previousSource = rank;
		destinations.add(key);
	}
	for (const row of form.computedDatums ?? []) {
		if (supplied.has(row.key))
			note(
				`“${row.key}” already supplies a value when the form opens. You can give this value a different name.`,
			);
		checkInput(row.key, row.value);
		computed.add(row.uuid);
		supplied.add(row.key);
	}
	return errors;
}
