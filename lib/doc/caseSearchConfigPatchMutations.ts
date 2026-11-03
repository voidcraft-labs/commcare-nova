/** Fresh-state, per-setting planners for the enabled Search settings bag. */

import { produce } from "immer";
import {
	enableCaseSearchMutation,
	removeCaseSearchConfigIfNoAuthoredSettingsMutation,
	setOwnerOnlyCaseSearchMutation,
} from "@/lib/doc/caseSearchConfigMutations";
import { deepEqual } from "@/lib/doc/deepEqual";
import { applyMutations } from "@/lib/doc/mutations";
import type { BlueprintDoc, Mutation } from "@/lib/doc/types";
import {
	type CaseSearchConfig,
	effectiveCaseSearchConfig,
	isOwnerOnlyCaseSearchConfig,
	type Module,
	type OrdinaryCaseSearchConfig,
	type Uuid,
	visibleSearchInputs,
} from "@/lib/domain";

type UpdateModuleMutation = Extract<Mutation, { kind: "updateModule" }>;
type CaseSearchConfigPatch = NonNullable<
	UpdateModuleMutation["caseSearchConfigPatch"]
>;

const SETTINGS = [
	"excludedOwnerIds",
	"searchScreenTitle",
	"searchScreenSubtitle",
	"searchButtonDisplayCondition",
	"workflow",
	"formsReadSearch",
] as const satisfies readonly (keyof CaseSearchConfigPatch)[];

/** Plan one whole editor projection as independent setting writes. */
export function caseSearchConfigPatchMutations(
	uuid: Uuid,
	current: CaseSearchConfig | undefined,
	next: CaseSearchConfig,
): Mutation[] {
	if (isOwnerOnlyCaseSearchConfig(next)) {
		return [setOwnerOnlyCaseSearchMutation(uuid, next)];
	}

	const currentEnabled =
		current !== undefined && !isOwnerOnlyCaseSearchConfig(current);
	const baseline: OrdinaryCaseSearchConfig =
		current === undefined
			? {}
			: isOwnerOnlyCaseSearchConfig(current)
				? { excludedOwnerIds: current.excludedOwnerIds }
				: current;
	const desired: OrdinaryCaseSearchConfig = structuredClone(next);
	const patch: CaseSearchConfigPatch = {};
	for (const key of SETTINGS) {
		if (deepEqual(baseline[key], desired[key])) continue;
		(patch as Record<string, unknown>)[key] = desired[key] ?? null;
	}

	const mutations: Mutation[] = [];
	if (current === undefined || !currentEnabled) {
		mutations.push(enableCaseSearchMutation(uuid, current));
	}
	if (Object.keys(patch).length > 0) {
		mutations.push({
			kind: "updateModule",
			uuid,
			patch: {},
			caseSearchConfigPatch: patch,
		});
	}
	return mutations;
}

/**
 * Clear the locally-present Search settings without deleting a peer-authored
 * fresh bag. This is the settings-editor spelling of "no settings remain";
 * structural teardown paths continue to use a plain `caseSearchConfig:null`.
 */
export function clearCaseSearchConfigSettingsMutations(
	uuid: Uuid,
	current: CaseSearchConfig | undefined,
): Mutation[] {
	if (current === undefined) return [];
	const normalized: OrdinaryCaseSearchConfig = isOwnerOnlyCaseSearchConfig(
		current,
	)
		? { excludedOwnerIds: current.excludedOwnerIds }
		: current;
	const patch: CaseSearchConfigPatch = {};
	for (const key of SETTINGS) {
		if (normalized[key] !== undefined) {
			(patch as Record<string, unknown>)[key] = null;
		}
	}
	const mutations: Mutation[] = [];
	if (Object.keys(patch).length > 0) {
		mutations.push({
			kind: "updateModule",
			uuid,
			patch: {},
			caseSearchConfigPatch: patch,
		});
	}
	mutations.push(removeCaseSearchConfigIfNoAuthoredSettingsMutation(uuid));
	return mutations;
}

/** Whether the module has an effective ordinary search with a Search field
 * a worker sees. */
function searchesWithVisibleField(module: Module | undefined): boolean {
	if (module === undefined) return false;
	return (
		effectiveCaseSearchConfig(module) !== undefined &&
		visibleSearchInputs(module.caseListConfig?.searchInputs ?? []).length > 0
	);
}

/**
 * Where a batch leaves a module with an effective ordinary search, no visible
 * Search field and an absent workflow, after it had a visible field or no
 * search, the module opens on its results: one `skipToResults` patch, after
 * the batch's own Search mutations. A module whose author chose search first
 * with no visible field keeps it; this reads the transition, not the state.
 */
export function workflowAfterInputChangeMutations(
	before: BlueprintDoc,
	after: BlueprintDoc,
	moduleUuid: Uuid,
): Mutation[] {
	const next = after.modules[moduleUuid];
	if (next === undefined) return [];
	const config = effectiveCaseSearchConfig(next);
	if (config === undefined || config.workflow !== undefined) return [];
	if (visibleSearchInputs(next.caseListConfig?.searchInputs ?? []).length > 0)
		return [];
	const previous = before.modules[moduleUuid];
	const hadSearch =
		previous !== undefined && effectiveCaseSearchConfig(previous) !== undefined;
	if (hadSearch && !searchesWithVisibleField(previous)) return [];
	return [
		{
			kind: "updateModule",
			uuid: moduleUuid,
			patch: {},
			caseSearchConfigPatch: { workflow: "skipToResults" },
		},
	];
}

/**
 * `mutations` with {@link workflowAfterInputChangeMutations} appended for each
 * module the batch changes: the composer an editor's Search batch goes
 * through, so enabling Search or removing or hiding its last visible field
 * never leaves the bare Search screen behind. A planner that reproduces a
 * stored target (the document diff) calls the per-setting planners alone.
 */
export function withWorkflowAfterInputChange(
	doc: BlueprintDoc,
	mutations: readonly Mutation[],
): Mutation[] {
	const moduleUuids = new Set<Uuid>();
	for (const mutation of mutations) {
		const moduleUuid = searchMutationModule(mutation);
		if (moduleUuid !== undefined) moduleUuids.add(moduleUuid);
	}
	if (moduleUuids.size === 0) return [...mutations];
	const after = produce(doc, (draft) => {
		applyMutations(draft, [...mutations]);
	});
	return [
		...mutations,
		...[...moduleUuids].flatMap((moduleUuid) =>
			workflowAfterInputChangeMutations(doc, after, moduleUuid),
		),
	];
}

/** The module whose Search fields or Search settings a mutation edits. */
function searchMutationModule(mutation: Mutation): Uuid | undefined {
	switch (mutation.kind) {
		case "addSearchInput":
		case "updateSearchInput":
		case "removeSearchInput":
			return mutation.moduleUuid;
		case "updateModule":
			return mutation.caseSearchConfigPatch !== undefined ||
				mutation.caseSearchConfigOperation !== undefined
				? mutation.uuid
				: undefined;
		default:
			return undefined;
	}
}
