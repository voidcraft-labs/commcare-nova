import { findContainingForm } from "@/lib/doc/mutations/helpers";
import {
	type BlueprintDoc,
	type CaseWriteVia,
	caseSelectionCardinality,
	type Field,
	fieldCaseWriteViews,
	fieldPreload,
	moduleUuidOfForm,
	type Uuid,
} from "@/lib/domain";
import { formStructure } from "@/lib/domain/expression/formStructure";
import { effectiveQueryRepeatPlacement } from "@/lib/domain/queryRepeatPlacement";

/** How a query repeat's rows come, in the words a read gives them: set when
 * the form opens (model iteration) or following the query as answers change
 * (the count placement). Undefined for any other field or one in no form. */
export function queryRepeatRows(
	doc: BlueprintDoc,
	field: Field,
): "set-when-opened" | "follow-query" | undefined {
	if (field.kind !== "repeat" || field.repeat_mode !== "query_bound")
		return undefined;
	const formUuid = findContainingForm(doc, field.uuid);
	const form = formUuid && formStructure(doc, formUuid);
	if (!form) return undefined;
	return effectiveQueryRepeatPlacement(form, field.uuid) === "model-iteration"
		? "set-when-opened"
		: "follow-query";
}

/** One place a question's answer is saved, as a read gives it: the case
 * property, the indices it walks to a case above this form's case, whether
 * it saves only changed answers or the link to a captured file, and the
 * case change that holds it. */
export interface FieldCaseWriteRead {
	readonly caseType: string;
	readonly property: string;
	readonly via?: CaseWriteVia;
	readonly onlyIfChanged?: true;
	readonly link?: true;
	readonly operationUuid: Uuid;
}

/** Every place `field`'s answer is saved, from the form's case changes
 * (`fieldCaseWriteViews`); empty when it saves nowhere. */
export function fieldCaseWrites(
	doc: BlueprintDoc,
	field: Field,
): FieldCaseWriteRead[] {
	return fieldCaseWriteViews(doc, field.uuid).map((view) => ({
		caseType: view.caseType,
		property: view.property,
		...(view.via !== undefined && { via: view.via }),
		...(view.onlyIfChanged && { onlyIfChanged: true as const }),
		...(view.link && { link: true as const }),
		operationUuid: view.operationUuid,
	}));
}

/** A readable projection of existing runtime rules, never authored state.
 * A starting value read from the case is the field's own `default_value`,
 * returned on the field, so a reader edits it like any default. */
export function effectiveFieldBehavior(doc: BlueprintDoc, field: Field) {
	const formUuid = findContainingForm(doc, field.uuid);
	const moduleUuid = formUuid && moduleUuidOfForm(doc, formUuid);
	const form = formUuid && doc.forms[formUuid];
	const module = moduleUuid && doc.modules[moduleUuid];
	if (!form || !module) return undefined;
	if (field.kind === "repeat") {
		const rows = queryRepeatRows(doc, field);
		return rows === undefined ? undefined : { rows };
	}
	if (
		field.kind === "group" ||
		field.kind === "section" ||
		field.kind === "label"
	)
		return undefined;
	const caseWrites = fieldCaseWrites(doc, field);
	const preload = fieldPreload(field);
	const calculated = field.kind === "hidden" && field.calculate !== undefined;
	const initialValue = calculated
		? { source: "calculation" as const }
		: preload !== undefined
			? {
					source: "selected-record" as const,
					caseType: preload.caseType,
					property: preload.property,
				}
			: "default_value" in field && field.default_value
				? { source: "configured-default" as const }
				: { source: "blank" as const };
	const savesToOwnCase = fieldCaseWriteViews(doc, field.uuid).some(
		(view) => view.destination === "own",
	);
	return {
		initialValue,
		...(caseWrites.length > 0 && { caseWrites }),
		...(savesToOwnCase &&
			(form.type === "followup" || form.type === "close") &&
			caseSelectionCardinality(module) === "multiple" && {
				blankAnswer: "preserves-each-record" as const,
			}),
	};
}
