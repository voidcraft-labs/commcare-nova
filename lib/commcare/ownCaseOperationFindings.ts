/**
 * `CASE_OWN_OPERATION`: a registration, follow-up or close form of a module
 * with a case type holds exactly one own arm, first in its operations; no
 * other form holds one. The case actions of a form are buildable only where
 * this holds, so the validator, the after-submit link projection and the
 * preceding-task read share this one statement of it.
 */
import {
	CASE_FORM_TYPES,
	type CaseOperation,
	type Form,
	formTypeLabels,
	type Uuid,
} from "@/lib/domain";
import { type ValidationError, validationError } from "./validator/errors";

export interface OwnCaseOperationPlace {
	readonly form: Pick<Form, "name" | "type" | "caseOperations">;
	readonly formUuid: Uuid;
	readonly moduleUuid: Uuid;
	readonly moduleName: string;
	/** The case type the form's module acts on; absent when it has none. */
	readonly caseType: string | undefined;
}

export function ownCaseOperationFindings(
	place: OwnCaseOperationPlace,
): ValidationError[] {
	const { form } = place;
	const operations: readonly CaseOperation[] = form.caseOperations ?? [];
	const owns = operations.filter((operation) => operation.action === "own");
	const belongs =
		place.caseType !== undefined && CASE_FORM_TYPES.has(form.type);
	const finding = (
		reason: "missing" | "duplicate" | "position" | "form-type",
		message: string,
	): ValidationError =>
		validationError(
			"CASE_OWN_OPERATION",
			"form",
			message,
			{
				moduleUuid: place.moduleUuid,
				moduleName: place.moduleName,
				formUuid: place.formUuid,
				formName: form.name,
			},
			{ reason, formType: form.type },
		);
	if (!belongs) {
		if (owns.length === 0) return [];
		return [
			form.type === "survey"
				? finding(
						"form-type",
						`“${form.name}” is a survey, so it has no case of its own to change. You can remove this change or choose another form type.`,
					)
				: finding(
						"form-type",
						`“${place.moduleName}” has no case type, so “${form.name}” has no case of its own to change. You can give the menu a case type or remove this change.`,
					),
		];
	}
	if (owns.length === 0)
		return [
			finding(
				"missing",
				`“${form.name}” is a ${formTypeLabels[form.type].toLowerCase()} form, so it needs a change for its own case, and it has none. Setting the form's type again adds it.`,
			),
		];
	const findings: ValidationError[] = [];
	if (owns.length > 1)
		findings.push(
			finding(
				"duplicate",
				`“${form.name}” has two changes for its own case. You can move the saves of one into the other and remove it.`,
			),
		);
	if (operations[0]?.action !== "own")
		findings.push(
			finding(
				"position",
				`The change for “${form.name}”'s own case has to come first. You can move the other changes after it.`,
			),
		);
	return findings;
}

/** `CASE_CREATE_NAME_MISSING`'s sentence: a registration's own case needs a
 * name before the form can create it. */
export function caseCreateNameMissingMessage(formName: string): string {
	return `“${formName}” creates a case, so its case needs a name. You can choose the question that names it.`;
}
