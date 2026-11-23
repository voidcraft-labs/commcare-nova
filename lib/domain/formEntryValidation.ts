import {
	formCaseSelections,
	ownFormSelectionIndex,
} from "./advancedEntryDatums";
import { advancedKindBlockers } from "./advancedModule";
import type { BlueprintDoc } from "./blueprint";
import type { LookupTypeIndex } from "./expression/context";
import { formStructure } from "./expression/formStructure";
import type { Expression } from "./expression/types";
import { walkExpressionTerms } from "./expression/walk";
import type { Form } from "./forms";
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
	if (!form.caseSelections && !form.computedDatums?.length) return [];
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
	if (
		form.caseSelections !== undefined &&
		(form.type === "followup" || form.type === "close") &&
		ownFormSelectionIndex(doc, form.uuid) === undefined
	)
		note(
			"its own record needs a choice from a list of its menu’s record type. You can add that choice or change the form type and its record changes together.",
		);
	if (menu && advancedKindBlockers(doc, menu).length)
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
			!formStructure(doc, form.uuid)?.fields.has(
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
