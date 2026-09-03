/**
 * Derived coverage for semantic module selection.
 *
 * Selection cardinality belongs to a Blueprint module, not to one form. A
 * form-and-queue or form-host module therefore affects every selected-record
 * or close form in that module, whether or not it has an authored WorkList. A
 * queue-only parent's selection is also carried into each same-record child
 * module with a case-loading form, so those child forms share the same
 * cardinality contract without configuring unrelated viewer-only children.
 */

import type {
	AppDesignContract,
	ModuleComposition,
} from "@/lib/agent/design/contract";
import type { DesignId } from "@/lib/agent/design/ids";

export function isCaseLoadingFormComposition(
	form: AppDesignContract["formCompositions"][number],
): boolean {
	return form.mode === "selected-record" || form.mode === "close";
}

/** Exact modules whose case-loading forms consume one module setting. */
export function selectionConsumerModules(
	contract: AppDesignContract,
	placement: ModuleComposition,
): readonly ModuleComposition[] {
	if (placement.role !== "queue-only") return [placement];
	return [
		placement,
		...contract.moduleCompositions.filter(
			(candidate) =>
				candidate.parentModuleCompositionId === placement.id &&
				candidate.hostRecordId === placement.hostRecordId,
		),
	];
}

/**
 * Exact workflow set affected by one module setting, in stable contract
 * workflow order. Actor-specific form variants collapse to their one owning
 * workflow.
 */
export function selectionConsumerWorkflowIds(
	contract: AppDesignContract,
	placement: ModuleComposition,
): readonly DesignId[] {
	const moduleIds = new Set(
		selectionConsumerModules(contract, placement).map((module) => module.id),
	);
	const consumerIds = new Set(
		contract.formCompositions
			.filter(
				(form) =>
					moduleIds.has(form.moduleCompositionId) &&
					isCaseLoadingFormComposition(form),
			)
			.map((form) => form.workflowId),
	);
	return contract.workflows
		.filter((workflow) => consumerIds.has(workflow.id))
		.map((workflow) => workflow.id);
}

export function sameIdentitySet(
	left: readonly string[],
	right: readonly string[],
): boolean {
	return (
		new Set(left).size === new Set(right).size &&
		left.every((id) => right.includes(id))
	);
}

export type ModuleSelectionIntent =
	| {
			readonly workflowIds: readonly DesignId[];
			readonly cases: "one";
	  }
	| {
			readonly workflowIds: readonly DesignId[];
			readonly cases: "several";
			readonly maximum: number;
	  };

/**
 * The one effective selection setting for a module. A same-record child of a
 * queue-only parent inherits the parent's selection only when one of its own
 * case-loading forms consumes that selection. A viewer- or registration-only
 * child has no Results cardinality to configure. If a consuming child also
 * declares its own setting, graph admission has already proved the direct and
 * inherited settings compatible.
 */
export function moduleSelectionIntent(
	contract: AppDesignContract,
	composition: ModuleComposition,
): ModuleSelectionIntent | undefined {
	const parent =
		composition.parentModuleCompositionId === undefined
			? undefined
			: contract.moduleCompositions.find(
					(candidate) => candidate.id === composition.parentModuleCompositionId,
				);
	const inheritedSelection =
		parent?.role === "queue-only" &&
		parent.hostRecordId === composition.hostRecordId &&
		parent.selection !== undefined
			? parent.selection
			: undefined;
	if (
		composition.selection === undefined &&
		inheritedSelection !== undefined &&
		!contract.formCompositions.some(
			(form) =>
				form.moduleCompositionId === composition.id &&
				isCaseLoadingFormComposition(form),
		)
	) {
		return undefined;
	}
	const primary = composition.selection ?? inheritedSelection;
	if (primary === undefined) return undefined;
	const workflowSet = new Set(
		[composition.selection, inheritedSelection].flatMap(
			(selection) => selection?.workflowIds ?? [],
		),
	);
	const workflowIds = contract.workflows
		.filter((workflow) => workflowSet.has(workflow.id))
		.map((workflow) => workflow.id);
	return primary.cases === "one"
		? {
				workflowIds,
				cases: "one",
			}
		: {
				workflowIds,
				cases: "several",
				maximum: primary.maximum,
			};
}

/** Latest covered workflow in deterministic BuildPlan order. */
export function selectionRealizationWorkflowId(
	workflowIds: readonly DesignId[],
	orderedWorkflowIds: readonly string[],
): DesignId | undefined {
	const covered = new Set<string>(workflowIds);
	return [...orderedWorkflowIds]
		.reverse()
		.find((workflowId): workflowId is DesignId => covered.has(workflowId));
}
