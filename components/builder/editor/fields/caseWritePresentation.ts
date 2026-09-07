import {
	CASE_LOADING_FORM_TYPES,
	type CaptureCaseWrite,
	type CaseWrite,
	type Field,
	type Form,
	isCaptureField,
	type Module,
	USERCASE_CASE_TYPE,
} from "@/lib/domain";
/**
 * The hashtag an author would write for one destination.
 *
 * The worker's own record is `#user/`, NOT `#commcare-user/`: `#user/` is the
 * namespace `lib/commcare/hashtags.ts` resolves, and `commcare-user` is a case
 * type nothing ever asks an author to name. Every other destination is its own
 * case type. One function because the chooser row and the chosen-state summary
 * both print this, and printing the same destination two ways reads as two
 * different places to save.
 */
export function destinationRef(caseType: string, property: string): string {
	return caseType === USERCASE_CASE_TYPE
		? `#user/${property}`
		: `#${caseType}/${property}`;
}

/** Presentation for the actual write destination and selected-case scope. This does not authorize a write. */
export function caseWriteGuidance(
	field: Field,
	context: {
		module: Pick<Module, "caseType" | "caseListConfig">;
		form: Pick<Form, "type">;
	} | null,
	current: CaseWrite | CaptureCaseWrite | undefined,
) {
	const savesAttachment = isCaptureField(field);
	const currentMode =
		current !== undefined && "mode" in current ? current.mode : "url";
	const writesEverySelectedCase =
		context !== null &&
		CASE_LOADING_FORM_TYPES.has(context.form.type) &&
		context.module.caseListConfig?.selection?.kind === "multiple" &&
		current !== undefined &&
		current.caseType === context.module.caseType;
	const hasStartingAnswer =
		("default_value" in field && field.default_value !== undefined) ||
		("calculate" in field && field.calculate !== undefined);
	const severalCaseHelp = !writesEverySelectedCase
		? undefined
		: savesAttachment
			? currentMode === "url"
				? "This attachment starts blank. When someone submits a file, its stored link updates this information on every selected case. Preview leaves each case's current value because it does not create that stored link."
				: "This attachment starts blank. When someone submits a file, it updates this information on every selected case. Preview leaves each case's current attachment because it does not create case attachments."
			: hasStartingAnswer
				? "This question has a starting value or calculation. When it produces an answer, that answer updates this information on every selected case, even if no one changes it."
				: "This question starts blank. Any answer someone enters updates this information on every selected case. Leaving it blank keeps each case's current value.";
	const severalCaseHelpIsWarning =
		severalCaseHelp !== undefined && (savesAttachment || hasStartingAnswer);
	return {
		writesEverySelectedCase,
		help: severalCaseHelp,
		warning: severalCaseHelpIsWarning,
	};
}
