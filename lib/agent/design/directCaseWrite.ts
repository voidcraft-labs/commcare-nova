/** Deterministic direct input-to-case-property lowering. */

import type {
	RecordProperty,
	Workflow,
	WorkflowInput,
} from "@/lib/agent/design/contract";
import { slugifyId } from "@/lib/domain/idSlug";

export interface FormLoweringContext {
	readonly caseType: string;
	readonly directSlotTaken: boolean;
	readonly repeatScopeCompatible: boolean;
}

export type DirectCaseWritePlan = { kind: "direct"; property: string } | null;

export function directCaseWritePlan(args: {
	readonly input: WorkflowInput;
	readonly property: RecordProperty;
	readonly workflow: Workflow;
	readonly formContext: FormLoweringContext;
}): DirectCaseWritePlan {
	const { input, property, workflow, formContext } = args;
	if (input.propertyId !== property.id) return null;
	if (
		!workflow.recordEffects.some((effect) =>
			effect.writes.some((write) => write.propertyId === property.id),
		)
	) {
		return null;
	}
	if (property.dataShape === "attachment" || property.dataShape === "unknown") {
		return null;
	}
	if (!formContext.repeatScopeCompatible || formContext.directSlotTaken)
		return null;
	const name = slugifyId(property.name, "");
	return name.length === 0 ? null : { kind: "direct", property: name };
}
