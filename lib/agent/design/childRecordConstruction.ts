import type { AppDesignContract } from "@/lib/agent/design/contract";

/**
 * Workflows whose forms create a record hosted by another menu. An optional
 * module narrows this to writers within a particular parent menu.
 *
 * Direct child-field writes require a viewer before their form lands. Design
 * records the intended create, before an executor chooses that implementation
 * or an explicit case operation. Establishing the accepted viewer first keeps
 * either implementation available, including when its parent is created in the
 * same slice.
 */
export function childRecordWriterWorkflowIds(
	contract: AppDesignContract,
	childHostRecordId: string,
	parentModuleCompositionId?: string,
): string[] {
	const parentFormWorkflowIds = new Set(
		contract.formCompositions
			.filter(
				(composition) =>
					(parentModuleCompositionId === undefined ||
						composition.moduleCompositionId === parentModuleCompositionId) &&
					composition.mode !== "standalone" &&
					contract.moduleCompositions.some(
						(module) =>
							module.id === composition.moduleCompositionId &&
							module.hostRecordId !== undefined &&
							module.hostRecordId !== childHostRecordId,
					),
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
