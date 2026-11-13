// components/builder/editor/fields/caseWritePresentation.ts
//
// The words around one row of a question's "Saves to": the hashtag a
// destination is written as, and what the row's write means when the form
// submits. Pure, so the row model and its tests read the same sentences
// the rail shows.

import {
	CASE_LOADING_FORM_TYPES,
	caseReferenceText,
	caseSelectionCardinality,
	type Field,
	type FieldCaseWriteView,
	type Form,
	humanizeId,
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
 * case type, spelled as reference text spells it (`caseReferenceText`). One function because the chooser row and the chosen-state summary
 * both print this, and printing the same destination two ways reads as two
 * different places to save.
 */
export function destinationRef(caseType: string, property: string): string {
	return caseType === USERCASE_CASE_TYPE
		? `#user/${property}`
		: caseReferenceText(caseType, property);
}

export interface CaseWriteGuidance {
	/** The form opens several cases and this write saves to each of them. */
	readonly writesEverySelectedCase: boolean;
	readonly help: string | undefined;
	/** The help states a consequence the author may not expect. */
	readonly warning: boolean;
}

const NO_GUIDANCE: CaseWriteGuidance = {
	writesEverySelectedCase: false,
	help: undefined,
	warning: false,
};

/**
 * What one write of the question's answer means when the form submits.
 * First match wins:
 *
 *   1. A several-case form writing its own case: the shared-answer copy (a
 *      warning when a starting value, a calculation or a file makes the
 *      write unconditional).
 *   2. A write to a new child case: each submission creates one, and on a
 *      several-case form one for every selected case
 *      (`lib/commcare/session.ts`).
 *   3. Anything else says nothing here. Whether the question opens with the
 *      case's value is its starting value, which the row's preload line
 *      states (`caseWriteRowModel.ts`).
 */
export function caseWriteGuidance(
	field: Field,
	context: {
		readonly module: Pick<Module, "caseType" | "caseListConfig">;
		readonly form: Pick<Form, "type">;
	} | null,
	view: Pick<FieldCaseWriteView, "destination" | "caseType"> | undefined,
): CaseWriteGuidance {
	if (context === null || view === undefined) return NO_GUIDANCE;
	const opensSeveralCases =
		CASE_LOADING_FORM_TYPES.has(context.form.type) &&
		caseSelectionCardinality(context.module) === "multiple";
	if (opensSeveralCases && view.destination === "own") {
		const savesFile = isCaptureField(field);
		const hasStartingAnswer =
			("default_value" in field && field.default_value !== undefined) ||
			("calculate" in field && field.calculate !== undefined);
		return {
			writesEverySelectedCase: true,
			help: savesFile
				? "This attachment starts blank. When someone submits a file, its stored link updates this information on every selected case. Preview leaves each case's current value because it does not create that stored link."
				: hasStartingAnswer
					? "This question has a starting value or calculation. When it produces an answer, that answer updates this information on every selected case, even if no one changes it."
					: "This question starts blank. Any answer someone enters updates this information on every selected case. Leaving it blank keeps each case's current value.",
			warning: savesFile || hasStartingAnswer,
		};
	}
	if (view.destination === "child") {
		const type = humanizeId(view.caseType);
		return {
			writesEverySelectedCase: false,
			help: opensSeveralCases
				? `Creates a new ${type} case for every selected case on each submission.`
				: `Creates a new ${type} case on each submission.`,
			warning: false,
		};
	}
	return NO_GUIDANCE;
}
