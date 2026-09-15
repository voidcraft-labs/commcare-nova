import type { AppDesignContract } from "@/lib/agent/design/contract";

/**
 * Workflows whose forms create a direct child of their host record.
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
): string[] {
	const parentRecordId = contract.records.find(
		(record) => record.id === childHostRecordId,
	)?.parentRecordId;
	if (parentRecordId === undefined) return [];
	const parentFormWorkflowIds = new Set(
		contract.formCompositions
			.filter(
				(composition) =>
					composition.mode !== "standalone" &&
					contract.moduleCompositions.some(
						(module) =>
							module.id === composition.moduleCompositionId &&
							module.hostRecordId === parentRecordId,
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
