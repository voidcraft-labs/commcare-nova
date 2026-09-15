import { childRecordWriterWorkflowIds } from "./childRecordConstruction";
import type { AppDesignContract } from "./contract";
import { hasCompleteReadSurfaces } from "./readWorkflows";

type ModuleComposition = AppDesignContract["moduleCompositions"][number];

/** A form home needs its first form; a list can be established whenever its
 * parent selection is ready. Claim those lists as workflows need them, rather
 * than assign a viewer to one writer before the other dependencies are known.
 * Worker starting conditions never schedule software. */
export function deriveConstructionSchedule(contract: AppDesignContract) {
	const workflows = [
		...contract.workflows.filter(
			(workflow) => workflow.id === contract.charter.initialWorkflowId,
		),
		...contract.workflows.filter(
			(workflow) => workflow.id !== contract.charter.initialWorkflowId,
		),
	];
	const authoredRank = new Map<string, number>(
		workflows.map((workflow, index) => [workflow.id, index]),
	);
	const earliest = (ids: readonly string[]) =>
		[...ids].sort(
			(a, b) =>
				(authoredRank.get(a) ?? Number.MAX_SAFE_INTEGER) -
				(authoredRank.get(b) ?? Number.MAX_SAFE_INTEGER),
		)[0];
	const modules = new Map<string, ModuleComposition>(
		contract.moduleCompositions.map((module) => [module.id, module]),
	);
	const firstForms = new Map<string, string | undefined>(
		contract.moduleCompositions.map((module) => [
			module.id,
			earliest(
				contract.formCompositions
					.filter((form) => form.moduleCompositionId === module.id)
					.map((form) => form.workflowId),
			),
		]),
	);
	const moduleOwners = new Map<string, string>();
	for (const module of contract.moduleCompositions) {
		if (module.listIds.length > 0) continue;
		const owner = firstForms.get(module.id) ?? earliest(module.workflowIds);
		if (owner !== undefined) moduleOwners.set(module.id, owner);
	}
	const prerequisites = new Map<string, Set<string>>(
		workflows.map((workflow) => [workflow.id, new Set<string>()]),
	);
	const completed = new Set<string>();
	const ordered: string[] = [];
	const add = (workflowId: string, dependency: string | undefined) => {
		if (dependency !== undefined && dependency !== workflowId)
			prerequisites.get(workflowId)?.add(dependency);
	};
	const parentFirstForm = (module: ModuleComposition) => {
		const parent = modules.get(module.parentModuleCompositionId ?? "");
		return parent !== undefined &&
			module.hostRecordId !== undefined &&
			module.hostRecordId !== parent.hostRecordId
			? firstForms.get(parent.id)
			: undefined;
	};
	// Readiness is read-only. A failed candidate cannot claim a home or constrain
	// another workflow. The path guard lets graph admission report bad menus.
	const canEstablish = (
		moduleId: string,
		workflowId: string,
		path = new Set<string>(),
	): boolean => {
		const module = modules.get(moduleId);
		if (module === undefined || path.has(moduleId)) return false;
		const owner = moduleOwners.get(moduleId);
		if (owner !== undefined) {
			if (completed.has(owner)) return true;
			if (owner !== workflowId) return false;
		}
		const parentForm = parentFirstForm(module);
		if (
			parentForm !== undefined &&
			parentForm !== workflowId &&
			!completed.has(parentForm)
		)
			return false;
		return (
			module.parentModuleCompositionId === undefined ||
			canEstablish(
				module.parentModuleCompositionId,
				workflowId,
				new Set([...path, moduleId]),
			)
		);
	};
	const claim = (
		moduleId: string,
		workflowId: string,
		path = new Set<string>(),
	): void => {
		const module = modules.get(moduleId);
		if (module === undefined || path.has(moduleId)) return;
		const owner = moduleOwners.get(moduleId);
		if (owner !== undefined && owner !== workflowId) {
			add(workflowId, owner);
			return;
		}
		if (module.parentModuleCompositionId !== undefined)
			claim(
				module.parentModuleCompositionId,
				workflowId,
				new Set([...path, moduleId]),
			);
		add(workflowId, parentFirstForm(module));
		moduleOwners.set(moduleId, workflowId);
	};
	const homesByWorkflow = new Map(
		workflows.map((workflow) => [
			workflow.id,
			[
				...new Set([
					...contract.formCompositions
						.filter((form) => form.workflowId === workflow.id)
						.map((form) => form.moduleCompositionId),
					...(hasCompleteReadSurfaces(contract, workflow) &&
					!contract.formCompositions.some(
						(form) => form.workflowId === workflow.id,
					)
						? contract.moduleCompositions
								.filter((module) => module.workflowIds.includes(workflow.id))
								.map((module) => module.id)
						: []),
				]),
			],
		]),
	);
	const viewersByWriter = new Map<string, string[][]>();
	for (const record of contract.records) {
		const viewers = contract.moduleCompositions
			.filter((module) => module.hostRecordId === record.id)
			.map((module) => module.id);
		if (viewers.length === 0) continue;
		for (const writer of childRecordWriterWorkflowIds(contract, record.id)) {
			const needs = viewersByWriter.get(writer) ?? [];
			needs.push(viewers);
			viewersByWriter.set(writer, needs);
		}
	}
	const availableViewer = (viewers: readonly string[], workflowId: string) =>
		// Reuse an established home before creating another accepted view.
		viewers.find((id) => completed.has(moduleOwners.get(id) ?? "")) ??
		viewers.find((id) => canEstablish(id, workflowId));
	let orderedWorkflowIds: string[] | null = ordered;
	while (completed.size < workflows.length) {
		const ready = workflows.filter(
			(workflow) =>
				!completed.has(workflow.id) &&
				(homesByWorkflow.get(workflow.id) ?? []).every((id) =>
					canEstablish(id, workflow.id),
				) &&
				(viewersByWriter.get(workflow.id) ?? []).every(
					(viewers) => availableViewer(viewers, workflow.id) !== undefined,
				),
		);
		if (ready.length === 0) {
			orderedWorkflowIds = null;
			break;
		}
		for (const workflow of ready) {
			for (const home of homesByWorkflow.get(workflow.id) ?? [])
				claim(home, workflow.id);
			for (const viewers of viewersByWriter.get(workflow.id) ?? []) {
				const viewer = availableViewer(viewers, workflow.id);
				if (viewer !== undefined) claim(viewer, workflow.id);
			}
			completed.add(workflow.id);
			ordered.push(workflow.id);
		}
	}
	// A list not needed by a form, a read task, or a child writer still belongs
	// in the app. Keep its first participating workflow, after parent selection.
	// On invalid graphs the same fallback supplies owners for useful diagnostics.
	const finalRank = new Map(
		(orderedWorkflowIds ?? workflows.map((workflow) => workflow.id)).map(
			(id, index) => [id, index],
		),
	);
	const assignRemaining = (
		moduleId: string,
		path = new Set<string>(),
	): void => {
		const module = modules.get(moduleId);
		if (
			module === undefined ||
			moduleOwners.has(moduleId) ||
			path.has(moduleId)
		)
			return;
		if (module.parentModuleCompositionId !== undefined)
			assignRemaining(
				module.parentModuleCompositionId,
				new Set([...path, moduleId]),
			);
		const preferred = [...module.workflowIds].sort(
			(a, b) => (finalRank.get(a) ?? 0) - (finalRank.get(b) ?? 0),
		)[0];
		const candidates = [
			preferred,
			moduleOwners.get(module.parentModuleCompositionId ?? ""),
			parentFirstForm(module),
		].filter((id): id is string => id !== undefined);
		const owner = candidates.sort(
			(a, b) => (finalRank.get(b) ?? 0) - (finalRank.get(a) ?? 0),
		)[0];
		if (owner === undefined) return;
		moduleOwners.set(moduleId, owner);
		add(owner, moduleOwners.get(module.parentModuleCompositionId ?? ""));
		add(owner, parentFirstForm(module));
	};
	for (const module of contract.moduleCompositions) assignRemaining(module.id);
	return { moduleOwners, prerequisites, orderedWorkflowIds };
}
