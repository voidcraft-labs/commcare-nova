import type { AppDesignContract } from "./contract";
import { parentFormChildWriterWorkflowIds } from "./nestedMenuConstruction";

/** Stable workflow order for both graph admission and plan derivation. */
export function constructionWorkflowOrder(
	contract: AppDesignContract,
): string[] | null {
	const remaining = new Set(contract.workflows.map((workflow) => workflow.id));
	const emitted: string[] = [];
	while (remaining.size > 0) {
		const ready = contract.workflows
			.filter(
				(workflow) =>
					remaining.has(workflow.id) &&
					workflow.prerequisiteWorkflowIds.every(
						(dependency) => !remaining.has(dependency),
					),
			)
			.map((workflow) => workflow.id);
		if (ready.length === 0) return null;
		const initialIndex = ready.indexOf(contract.charter.initialWorkflowId);
		if (initialIndex > 0) ready.unshift(...ready.splice(initialIndex, 1));
		for (const id of ready) {
			remaining.delete(id);
			emitted.push(id);
		}
	}
	return emitted;
}

/** A menu's workflow membership describes its use, not its construction owner.
 * A list can establish its home before that home's forms are added. Schedule
 * such a child after its parent selection exists and by its first case writer.
 * Form-only homes retain their first form's owner. */
export function deriveModuleConstructionOwners(
	contract: AppDesignContract,
	orderedWorkflowIds: readonly string[],
): Map<string, string> {
	const rank = new Map(orderedWorkflowIds.map((id, index) => [id, index]));
	const index = (id: string | undefined) =>
		id === undefined
			? Number.MAX_SAFE_INTEGER
			: (rank.get(id) ?? Number.MAX_SAFE_INTEGER);
	const earliest = (ids: readonly string[]) =>
		[...ids].sort((left, right) => index(left) - index(right))[0];
	const firstForm = (moduleId: string) =>
		earliest(
			contract.formCompositions
				.filter((form) => form.moduleCompositionId === moduleId)
				.map((form) => form.workflowId),
		);
	const owners = new Map<string, string>();
	for (const module of contract.moduleCompositions) {
		const owner =
			(module.listIds.length === 0 ? firstForm(module.id) : undefined) ??
			earliest(module.workflowIds);
		if (owner !== undefined) owners.set(module.id, owner);
	}
	for (const module of contract.moduleCompositions) {
		if (module.listIds.length === 0) continue;
		const parent = contract.moduleCompositions.find(
			(candidate) => candidate.id === module.parentModuleCompositionId,
		);
		if (!parent) continue;
		const differentRecord =
			module.hostRecordId !== undefined &&
			module.hostRecordId !== parent.hostRecordId;
		const firstWriter =
			differentRecord && module.hostRecordId !== undefined
				? earliest(
						parentFormChildWriterWorkflowIds(
							contract,
							parent.id,
							module.hostRecordId,
						),
					)
				: undefined;
		let owner = owners.get(module.id);
		if (firstWriter !== undefined && index(firstWriter) < index(owner))
			owner = firstWriter;
		for (const prerequisite of [
			owners.get(parent.id),
			differentRecord ? firstForm(parent.id) : undefined,
		]) {
			if (prerequisite !== undefined && index(prerequisite) > index(owner))
				owner = prerequisite;
		}
		if (owner !== undefined) owners.set(module.id, owner);
	}
	return owners;
}
