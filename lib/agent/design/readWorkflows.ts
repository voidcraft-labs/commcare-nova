import type { AppDesignContract, Workflow } from "./contract";

/** Reading saved records is a worker task even when nothing is submitted. */
export function isReadWorkflow(workflow: Workflow): boolean {
	return (
		workflow.inputs.length === 0 &&
		workflow.decisions.length === 0 &&
		workflow.recordEffects.length === 0 &&
		workflow.authoredFeatures.length === 0 &&
		workflow.readback.length > 0
	);
}

/** Every actor must be able to see each requested value in a list or detail
 * view placed in this workflow. Searchable-but-hidden properties do not count. */
export function hasCompleteReadSurfaces(
	contract: AppDesignContract,
	workflow: Workflow,
): boolean {
	if (!isReadWorkflow(workflow)) return false;
	return workflow.actorIds.every((actorId) =>
		workflow.readback.every((readback) => {
			const listIds = new Set(
				contract.moduleCompositions
					.filter(
						(module) =>
							module.workflowIds.includes(workflow.id) &&
							module.actorIds.includes(actorId) &&
							module.hostRecordId === readback.recordId,
					)
					.flatMap((module) => module.listIds),
			);
			const lists = contract.lists.filter(
				(list) =>
					listIds.has(list.id) &&
					list.recordId === readback.recordId &&
					list.actorIds.includes(actorId),
			);
			const visible = new Set(
				lists.flatMap((list) => [
					...list.scanPropertyIds,
					...list.detailPropertyIds,
				]),
			);
			return (
				lists.length > 0 && readback.propertyIds.every((id) => visible.has(id))
			);
		}),
	);
}

/** A read task whose entire implementation belongs to earlier construction
 * work needs no extra executor turn or artificial mutation. Its workflow
 * element joins the last prerequisite's existing construction group. */
export function assignReadWorkflowOwners(args: {
	contract: AppDesignContract;
	orderedWorkflowIds: readonly string[];
	ownerByElement: Map<string, string>;
	prerequisites: ReadonlyMap<string, readonly string[]>;
}): void {
	const { contract, orderedWorkflowIds, ownerByElement, prerequisites } = args;
	const rank = new Map(orderedWorkflowIds.map((id, index) => [id, index]));
	for (const workflowId of orderedWorkflowIds) {
		const workflow = contract.workflows.find((item) => item.id === workflowId);
		if (
			workflow === undefined ||
			workflowId === contract.charter.initialWorkflowId ||
			!hasCompleteReadSurfaces(contract, workflow) ||
			contract.formCompositions.some(
				(form) => form.workflowId === workflowId,
			) ||
			[...ownerByElement].some(
				([id, owner]) => id !== workflowId && owner === workflowId,
			)
		) {
			continue;
		}
		const dependencies = new Set<string>(prerequisites.get(workflowId));
		const includeOwner = (id: string) => {
			const owner = ownerByElement.get(id);
			if (owner !== undefined && owner !== workflowId) dependencies.add(owner);
		};
		for (const module of contract.moduleCompositions) {
			if (!module.workflowIds.includes(workflow.id)) continue;
			includeOwner(module.id);
			for (const id of module.listIds) includeOwner(id);
		}
		for (const readback of workflow.readback) {
			includeOwner(readback.recordId);
			for (const id of readback.propertyIds) includeOwner(id);
		}
		const owners = [...dependencies].map((id) => ownerByElement.get(id) ?? id);
		const owner = owners.sort(
			(a, b) => (rank.get(b) ?? -1) - (rank.get(a) ?? -1),
		)[0];
		if (
			owner !== undefined &&
			(rank.get(owner) ?? Infinity) < (rank.get(workflowId) ?? -1)
		)
			ownerByElement.set(workflowId, owner);
	}
}
