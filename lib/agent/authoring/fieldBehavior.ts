import { findContainingForm } from "@/lib/doc/mutations/helpers";
import {
	type BlueprintDoc,
	caseSelectionCardinality,
	type Field,
	fieldCaseWrite,
	moduleUuidOfForm,
	writerPreloadsFromLoadedCase,
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

/** A readable projection of existing runtime rules, never authored state.
 * Explicit defaults are still returned on the field so a reader can edit them. */
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
	const write = fieldCaseWrite(field);
	const preload = writerPreloadsFromLoadedCase(field, module, form);
	const calculated = field.kind === "hidden" && field.calculate !== undefined;
	const initialValue = calculated
		? { source: "calculation" as const }
		: preload && write
			? {
					source: "selected-record" as const,
					caseType: write.caseType,
					property: write.property,
					...("default_value" in field &&
						field.default_value && { configuredDefaultIsOverridden: true }),
				}
			: "default_value" in field && field.default_value
				? { source: "configured-default" as const }
				: { source: "blank" as const };
	return {
		initialValue,
		...(write &&
			write.caseType === module.caseType &&
			(form.type === "followup" || form.type === "close") &&
			caseSelectionCardinality(module) === "multiple" && {
				blankAnswer: "preserves-each-record" as const,
			}),
	};
}
