import type { AppDesignContract } from "@/lib/agent/design/contract";

/**
 * Workflows whose forms live in `parentModuleCompositionId` and create the
 * record displayed by its different-record child menu.
 *
 * Direct child-field writes require a viewer before their form lands. Design
 * records the intended create, before an executor chooses that implementation
 * or an explicit case operation. Establishing the accepted viewer first keeps
 * either implementation available, including when its parent is created in the
 * same slice.
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
