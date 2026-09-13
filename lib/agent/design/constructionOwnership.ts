import { childRecordWriterWorkflowIds } from "./childRecordConstruction";
import type { AppDesignContract } from "./contract";
import { hasCompleteReadSurfaces } from "./readWorkflows";

/** Stable workflow order for both graph admission and plan derivation. */
function workflowOrder(
	contract: AppDesignContract,
	prerequisites: ReadonlyMap<string, ReadonlySet<string>>,
): string[] | null {
	const remaining = new Set<string>(
		contract.workflows.map((workflow) => workflow.id),
	);
	const emitted: string[] = [];
	while (remaining.size > 0) {
		const ready = contract.workflows
			.filter(
				(workflow) =>
					remaining.has(workflow.id) &&
					[...(prerequisites.get(workflow.id) ?? [])].every(
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
function deriveModuleConstructionOwners(
	contract: AppDesignContract,
	orderedWorkflowIds: readonly string[],
	viewerByRecord: ReadonlyMap<string, string>,
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
	for (const [recordId, moduleId] of viewerByRecord) {
		const module = contract.moduleCompositions.find(
			(item) => item.id === moduleId,
		);
		if (module === undefined || module.listIds.length === 0) continue;
		const firstWriter = earliest(
			childRecordWriterWorkflowIds(contract, recordId),
		);
		if (
			firstWriter !== undefined &&
			index(firstWriter) < index(owners.get(moduleId))
		)
			owners.set(moduleId, firstWriter);
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
		let owner = owners.get(module.id);
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

function scheduleWithViewers(
	contract: AppDesignContract,
	ownershipOrder: readonly string[],
	viewerByRecord: ReadonlyMap<string, string>,
) {
	const prerequisites = new Map<string, Set<string>>(
		contract.workflows.map((workflow) => [workflow.id, new Set<string>()]),
	);
	const moduleOwners = deriveModuleConstructionOwners(
		contract,
		ownershipOrder,
		viewerByRecord,
	);
	const rank = new Map(ownershipOrder.map((id, index) => [id, index]));
	const add = (
		workflowId: string | undefined,
		dependency: string | undefined,
	) => {
		if (
			workflowId !== undefined &&
			dependency !== undefined &&
			workflowId !== dependency
		)
			prerequisites.get(workflowId)?.add(dependency);
	};
	for (const [recordId, moduleId] of viewerByRecord)
		for (const writer of childRecordWriterWorkflowIds(contract, recordId))
			add(writer, moduleOwners.get(moduleId));
	for (const form of contract.formCompositions)
		add(form.workflowId, moduleOwners.get(form.moduleCompositionId));
	for (const workflow of contract.workflows) {
		if (
			!hasCompleteReadSurfaces(contract, workflow) ||
			contract.formCompositions.some((form) => form.workflowId === workflow.id)
		)
			continue;
		for (const module of contract.moduleCompositions) {
			if (module.workflowIds.includes(workflow.id))
				add(workflow.id, moduleOwners.get(module.id));
		}
	}
	for (const module of contract.moduleCompositions) {
		const parent = contract.moduleCompositions.find(
			(candidate) => candidate.id === module.parentModuleCompositionId,
		);
		if (!parent) continue;
		const owner = moduleOwners.get(module.id);
		add(owner, moduleOwners.get(parent.id));
		if (
			module.hostRecordId === undefined ||
			module.hostRecordId === parent.hostRecordId
		)
			continue;
		const firstParentFormOwner = contract.formCompositions
			.filter((form) => form.moduleCompositionId === parent.id)
			.map((form) => form.workflowId)
			.sort(
				(left, right) =>
					(rank.get(left) ?? Number.MAX_SAFE_INTEGER) -
					(rank.get(right) ?? Number.MAX_SAFE_INTEGER),
			)[0];
		add(owner, firstParentFormOwner);
	}
	return {
		moduleOwners,
		prerequisites,
		orderedWorkflowIds: workflowOrder(contract, prerequisites),
	};
}

/** Construction follows the actual menu and form graph. Worker starting
 * conditions do not schedule software. Use the chosen initial workflow first,
 * then design order to break ties. */
export function deriveConstructionSchedule(contract: AppDesignContract) {
	const ownershipOrder = [
		contract.charter.initialWorkflowId,
		...contract.workflows
			.filter((workflow) => workflow.id !== contract.charter.initialWorkflowId)
			.map((workflow) => workflow.id),
	];
	const viewers = new Map<string, string>();
	let schedule = scheduleWithViewers(contract, ownershipOrder, viewers);
	for (const record of contract.records) {
		const writers = childRecordWriterWorkflowIds(contract, record.id);
		if (writers.length === 0) continue;
		const rank = new Map(
			(schedule.orderedWorkflowIds ?? ownershipOrder).map((id, index) => [
				id,
				index,
			]),
		);
		const firstWriter = Math.min(
			...writers.map((id) => rank.get(id) ?? Number.MAX_SAFE_INTEGER),
		);
		const available = (moduleId: string) => {
			const owner = schedule.moduleOwners.get(moduleId);
			return (
				owner !== undefined &&
				(rank.get(owner) ?? Number.MAX_SAFE_INTEGER) <= firstWriter
			);
		};
		// Any accepted viewer can support direct child writes. Keep an available
		// home; otherwise prefer a list that can be established without its forms.
		// A later viewer is useful only if it can precede the writers without a
		// cycle. Other views keep their own construction owners.
		const candidates = contract.moduleCompositions
			.filter((module) => module.hostRecordId === record.id)
			.sort(
				(a, b) =>
					Number(available(b.id)) - Number(available(a.id)) ||
					Number(b.listIds.length > 0) - Number(a.listIds.length > 0) ||
					Number(a.parentModuleCompositionId !== undefined) -
						Number(b.parentModuleCompositionId !== undefined),
			);
		let selected: typeof schedule | undefined;
		let selectedModuleId: string | undefined;
		for (const candidate of candidates) {
			const trial = scheduleWithViewers(
				contract,
				ownershipOrder,
				new Map([...viewers, [record.id, candidate.id]]),
			);
			// Keep the first failed candidate so admission can report a real
			// dependency when no viewer is feasible, rather than omit the need.
			selected ??= trial;
			selectedModuleId ??= candidate.id;
			if (
				trial.orderedWorkflowIds !== null &&
				trial.prerequisites.get(contract.charter.initialWorkflowId)?.size === 0
			) {
				selected = trial;
				selectedModuleId = candidate.id;
				break;
			}
		}
		if (selected !== undefined && selectedModuleId !== undefined) {
			viewers.set(record.id, selectedModuleId);
			schedule = selected;
		}
	}
	return schedule;
}
