import {
	CASE_LOADING_FORM_TYPES,
	type CaptureCaseWrite,
	type CaseWrite,
	caseSelectionCardinality,
	caseWriteDestinationClass,
	type Field,
	type Form,
	humanizeId,
	isCaptureField,
	type Module,
	USERCASE_CASE_TYPE,
	writerPreloadsFromLoadedCase,
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

/**
 * What the chosen destination means when the form opens and when it submits.
 *
 * The line under the Saves to chooser is the one place the rail says what a
 * case-bound field DOES rather than where it lands, and it has to agree with
 * the running form: `writerPreloadsFromLoadedCase` is the same predicate the
 * preview engine seeds from. Priority, first match wins:
 *
 *   1. A several-case form writing the module's own type: the shared-answer
 *      copy (a warning when a starting value or attachment makes the write
 *      unconditional), unchanged from before the other lines existed.
 *   2. A writer the form preloads: it opens with the case's current value,
 *      unless it is a hidden field whose calculation owns the value (the
 *      preload still happens; the calculation replaces it before anyone
 *      reads it).
 *   3. A writer to a child type, on any form type: each submission creates a
 *      new case of that type, so the question always opens blank.
 *   4. Anything else says nothing.
 *
 * `current` is the destination the chooser is showing, which during a
 * selection is not yet the one stored on the field, so the preload predicate
 * reads the shown pair rather than the stored one. This does not authorize a
 * write.
 */
export function caseWriteGuidance(
	field: Field,
	context: {
		module: Pick<Module, "caseType" | "caseListConfig">;
		form: Pick<Form, "type">;
	} | null,
	current: CaseWrite | CaptureCaseWrite | undefined,
): {
	writesEverySelectedCase: boolean;
	preloadsFromLoadedCase: boolean;
	help: string | undefined;
	warning: boolean;
} {
	const savesAttachment = isCaptureField(field);
	const currentMode =
		current !== undefined && "mode" in current ? current.mode : "url";
	const destination =
		context === null
			? "none"
			: caseWriteDestinationClass(current, context.module);
	const writesEverySelectedCase =
		context !== null &&
		destination === "own" &&
		CASE_LOADING_FORM_TYPES.has(context.form.type) &&
		caseSelectionCardinality(context.module) === "multiple";
	const preloadsFromLoadedCase =
		context !== null &&
		current !== undefined &&
		writerPreloadsFromLoadedCase(
			{ ...field, caseWrite: current } as Field,
			context.module,
			context.form,
		);
	const hasStartingAnswer =
		("default_value" in field && field.default_value !== undefined) ||
		("calculate" in field && field.calculate !== undefined);
	if (writesEverySelectedCase) {
		const help = savesAttachment
			? currentMode === "url"
				? "This attachment starts blank. When someone submits a file, its stored link updates this information on every selected case. Preview leaves each case's current value because it does not create that stored link."
				: "This attachment starts blank. When someone submits a file, it updates this information on every selected case. Preview leaves each case's current attachment because it does not create case attachments."
			: hasStartingAnswer
				? "This question has a starting value or calculation. When it produces an answer, that answer updates this information on every selected case, even if no one changes it."
				: "This question starts blank. Any answer someone enters updates this information on every selected case. Leaving it blank keeps each case's current value.";
		return {
			writesEverySelectedCase,
			preloadsFromLoadedCase,
			help,
			warning: savesAttachment || hasStartingAnswer,
		};
	}
	if (preloadsFromLoadedCase) {
		const calculated = field.kind === "hidden" && field.calculate !== undefined;
		return {
			writesEverySelectedCase,
			preloadsFromLoadedCase,
			help: calculated
				? "The calculation sets this value."
				: "Opens with this case's current value.",
			warning: false,
		};
	}
	if (destination === "child" && current !== undefined) {
		return {
			writesEverySelectedCase,
			preloadsFromLoadedCase,
			help: `Creates a new ${humanizeId(current.caseType)} case on each submission.`,
			warning: false,
		};
	}
	return {
		writesEverySelectedCase,
		preloadsFromLoadedCase,
		help: undefined,
		warning: false,
	};
}
