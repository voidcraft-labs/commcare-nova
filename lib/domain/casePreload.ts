/**
 * Which answers a form seeds from the case it opened.
 *
 * A followup or close form in a module that opens ONE case at a time reads
 * every property it will update back out of that case at form open, so the
 * worker edits the current value in place. This module is the one statement
 * of that rule for every surface that has to agree with the running form:
 * the builder's inspector (what a field's "Default value" row means, what the
 * destination line says), the preview engine (which fields it seeds from the
 * loaded row), and the pure guidance helpers between them. The compiled
 * XForm reaches the same answer through the case-write inventory
 * (`lib/commcare/deriveCaseConfig.ts` copies the primary update writers into
 * the preload action), so a change here must keep that projection honest.
 *
 * What preloads: a scalar writer whose destination is the module's own case
 * type, `case_name` included. What never preloads: a writer to a child type
 * (each submission creates a new case, so there is nothing to read), a writer
 * to the worker's own record (`#user/<prop>` already reads it), any capture
 * kind (a stored link or attachment is not an upload filename for the new
 * submission), any field on a several-case form (there is no single case to
 * read), and every field on a registration or survey form.
 *
 * Inside a repeat, the running form seeds only the first instance; the
 * predicate answers for the field's destination, not its instance count.
 */

import { fieldCaseWrite } from "./caseTypes";
import type { CaptureCaseWrite, CaseWrite, Field } from "./fields";
import { isCaptureField } from "./fields";
import { CASE_LOADING_FORM_TYPES, type Form, type FormType } from "./forms";
import {
	type CaseSelectionCardinality,
	caseSelectionCardinality,
	type Module,
} from "./modules";
import { USERCASE_CASE_TYPE } from "./usercase";

/** A form whose entry loads exactly one existing case before it opens. */
export function formOpensWithOneCase(
	formType: FormType,
	cardinality: CaseSelectionCardinality,
): boolean {
	return CASE_LOADING_FORM_TYPES.has(formType) && cardinality === "single";
}

/**
 * Whether this field opens showing the loaded case's current value for the
 * property it writes.
 */
export function writerPreloadsFromLoadedCase(
	field: Field,
	module: Pick<Module, "caseType" | "caseListConfig">,
	form: Pick<Form, "type">,
): boolean {
	if (!formOpensWithOneCase(form.type, caseSelectionCardinality(module))) {
		return false;
	}
	if (module.caseType === undefined) return false;
	if (isCaptureField(field)) return false;
	return fieldCaseWrite(field)?.caseType === module.caseType;
}

/**
 * `writerPreloadsFromLoadedCase` over the inspector's nullable context. With
 * no context nothing is known about the form the field sits in, so nothing
 * is claimed to preload.
 */
export function writerPreloadsInContext(
	field: Field,
	context: {
		readonly module: Pick<Module, "caseType" | "caseListConfig">;
		readonly form: Pick<Form, "type">;
	} | null,
): boolean {
	return (
		context !== null &&
		writerPreloadsFromLoadedCase(field, context.module, context.form)
	);
}

/**
 * Where a destination lands relative to the form's module: the module's own
 * case (edited in place on a one-case followup), a child case (created on
 * each submission), or the worker's own record. The chooser only ever offers
 * those three, so anything that is neither own nor worker is a child.
 */
export type CaseWriteDestinationClass =
	| "own"
	| "child"
	| "worker-record"
	| "none";

export function caseWriteDestinationClass(
	current: CaseWrite | CaptureCaseWrite | undefined,
	module: Pick<Module, "caseType">,
): CaseWriteDestinationClass {
	if (current === undefined) return "none";
	if (current.caseType === USERCASE_CASE_TYPE) return "worker-record";
	if (module.caseType !== undefined && current.caseType === module.caseType) {
		return "own";
	}
	return "child";
}
