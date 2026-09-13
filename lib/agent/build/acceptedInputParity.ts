/** Deterministic parity between accepted workflow-input requiredness and the
 * exact realized form fields in a private build candidate. */

import { findContainingForm } from "@/lib/doc/mutations/helpers";
import { type BlueprintDoc, moduleUuidOfForm } from "@/lib/domain";
import type { ModuleHandleBinding } from "./acceptedModulePlacement";
import {
	blueprintFormHandle,
	blueprintInputHandle,
	formCompositionInputs,
	type SliceExecutionBrief,
} from "./executionBrief";

export interface AcceptedInputRequirementIssue {
	readonly code: "ACCEPTED_INPUT_REQUIREMENT_MISMATCH";
	readonly message: string;
	readonly location: {
		readonly kind: "field";
		readonly moduleUuid: string;
		readonly formUuid: string;
		readonly fieldUuid: string;
	};
	readonly details: {
		readonly formCompositionId: string;
		readonly inputHandle: string;
		readonly blueprintFieldId: string;
		readonly acceptedRequiredWhen: string | null;
		readonly realizedRequired: boolean;
	};
}

/** Compare one exact, machine-addressable part of accepted intent with the
 * realized candidate. Record-catalog requiredness is deliberately ignored:
 * the workflow input owns whether this question is required in this form.
 *
 * Missing forms/fields remain the later complete conformance review's job.
 * This narrow finalizer proof runs only where the accepted lowering resolves
 * one actual field, so it cannot turn fuzzy label/name matching into a gate. */
export function acceptedInputRequirementIssues(
	doc: BlueprintDoc,
	brief: SliceExecutionBrief,
	handles: readonly ModuleHandleBinding[],
): AcceptedInputRequirementIssue[] {
	const issues: AcceptedInputRequirementIssue[] = [];
	const inputsByHandle = new Map(
		brief.workflow.inputs.map((input) => [input.handle, input]),
	);
	const bindings = new Map(handles.map((binding) => [binding.handle, binding]));
	for (const realization of brief.formRealizations) {
		const formBinding = bindings.get(
			blueprintFormHandle(realization.compositionId),
		);
		if (formBinding?.entityKind !== "form") continue;
		const form = doc.forms[formBinding.uuid];
		if (!form) continue;
		const moduleUuid = moduleUuidOfForm(doc, form.uuid);
		if (!moduleUuid) continue;
		for (const item of formCompositionInputs(realization)) {
			const input = inputsByHandle.get(item.inputHandle);
			const fieldBinding = bindings.get(
				blueprintInputHandle(item.compositionItemId),
			);
			if (!input || fieldBinding?.entityKind !== "field") continue;
			const field = doc.fields[fieldBinding.uuid];
			if (!field || findContainingForm(doc, field.uuid) !== form.uuid) continue;
			const acceptedRequired = input.requiredWhen !== undefined;
			const realizedRequired =
				"required" in field && field.required !== undefined;
			if (realizedRequired === acceptedRequired) continue;
			issues.push({
				code: "ACCEPTED_INPUT_REQUIREMENT_MISMATCH",
				message: acceptedRequired
					? `Input ${item.inputHandle} needs a required condition for "${input.requiredWhen}".`
					: `Input ${item.inputHandle} is optional in this workflow. Remove its required condition.`,
				location: {
					kind: "field",
					moduleUuid,
					formUuid: form.uuid,
					fieldUuid: field.uuid,
				},
				details: {
					formCompositionId: realization.compositionId,
					inputHandle: item.inputHandle,
					blueprintFieldId: field.id,
					acceptedRequiredWhen: input.requiredWhen ?? null,
					realizedRequired,
				},
			});
		}
	}
	return issues;
}
