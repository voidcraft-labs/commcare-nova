import type { AppDesignContract } from "@/lib/agent/design/contract";

/**
 * Workflows whose forms live in `parentModuleCompositionId` and create the
 * record displayed by its different-record child menu.
 *
 * This is the exact valid-by-construction pressure behind the staged build:
 * the child viewer must exist before any of these forms lands, even though its
 * final navigation parent might be created by that same form call.
 */
export function parentFormChildWriterWorkflowIds(
	contract: AppDesignContract,
	parentModuleCompositionId: string,
	childHostRecordId: string,
): string[] {
	const parentFormWorkflowIds = new Set(
		contract.formCompositions
			.filter(
				(composition) =>
					composition.moduleCompositionId === parentModuleCompositionId,
			)
			.map((composition) => composition.workflowId),
	);
	return contract.workflows
		.filter(
			(workflow) =>
				parentFormWorkflowIds.has(workflow.id) &&
				workflow.recordEffects.some(
					(effect) =>
						effect.kind === "create" && effect.recordId === childHostRecordId,
				),
		)
		.map((workflow) => workflow.id);
}
