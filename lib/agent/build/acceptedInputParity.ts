/** Deterministic parity between accepted workflow-input requiredness and the
 * exact realized form fields in a private build candidate. */

import type { BlueprintDoc } from "@/lib/domain";
import type { SliceExecutionBrief } from "./executionBrief";

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

function formFieldUuids(doc: BlueprintDoc, formUuid: string): string[] {
	const found: string[] = [];
	const pending = [formUuid];
	const visited = new Set<string>();
	while (pending.length > 0) {
		const parentUuid = pending.pop();
		if (parentUuid === undefined || visited.has(parentUuid)) continue;
		visited.add(parentUuid);
		for (const fieldUuid of doc.fieldOrder[parentUuid] ?? []) {
			found.push(fieldUuid);
			pending.push(fieldUuid);
		}
	}
	return found;
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
): AcceptedInputRequirementIssue[] {
	const issues: AcceptedInputRequirementIssue[] = [];
	const inputsByHandle = new Map(
		brief.workflow.inputs.map((input) => [input.handle, input]),
	);
	for (const realization of brief.formRealizations) {
		const moduleComposition = brief.moduleCompositions.find(
			(composition) => composition.id === realization.moduleCompositionId,
		);
		const host = brief.moduleRealizations.find(
			(module) => module.compositionId === realization.moduleCompositionId,
		)?.hostRecord;
		if (moduleComposition === undefined) continue;
		const moduleUuids = doc.moduleOrder.filter((moduleUuid) => {
			const module = doc.modules[moduleUuid];
			return (
				module?.name === moduleComposition.name &&
				(module.caseType ?? null) === (host?.blueprintCaseType ?? null)
			);
		});
		const formUuids = moduleUuids.flatMap((moduleUuid) =>
			(doc.formOrder[moduleUuid] ?? []).filter((formUuid) => {
				const form = doc.forms[formUuid];
				return (
					form?.name === realization.name &&
					form.type === realization.blueprintFormType
				);
			}),
		);
		const loweredItems =
			realization.layoutLowering.kind === "root-fields"
				? realization.layoutLowering.items
				: realization.layoutLowering.groups.flatMap((group) => group.items);
		for (const item of loweredItems) {
			if (
				item.blueprintFieldKind !== "workflow-input" ||
				item.inputHandle === undefined
			) {
				continue;
			}
			const input = inputsByHandle.get(item.inputHandle);
			const blueprintFieldId = item.blueprintFieldId ?? item.inputHandle;
			if (input === undefined) continue;
			const acceptedRequired = input.requiredWhen !== undefined;
			for (const formUuid of formUuids) {
				for (const fieldUuid of formFieldUuids(doc, formUuid)) {
					const field = doc.fields[fieldUuid];
					if (field?.id !== blueprintFieldId) continue;
					const realizedRequired =
						"required" in field && field.required !== undefined;
					if (realizedRequired === acceptedRequired) continue;
					issues.push({
						code: "ACCEPTED_INPUT_REQUIREMENT_MISMATCH",
						message: acceptedRequired
							? `Accepted input ${item.inputHandle} is required when "${input.requiredWhen}", but field ${blueprintFieldId} has no required condition. Add the accepted condition to this field.`
							: `Accepted input ${item.inputHandle} has no required condition, but field ${blueprintFieldId} is required. Remove the field's required rule; record-level requiredness does not apply automatically to this form.`,
						location: {
							kind: "field",
							moduleUuid:
								moduleUuids.find((moduleUuid) =>
									(doc.formOrder[moduleUuid] ?? []).includes(formUuid),
								) ?? "",
							formUuid,
							fieldUuid,
						},
						details: {
							formCompositionId: realization.compositionId,
							inputHandle: item.inputHandle,
							blueprintFieldId,
							acceptedRequiredWhen: input.requiredWhen ?? null,
							realizedRequired,
						},
					});
				}
			}
		}
	}
	return issues;
}
