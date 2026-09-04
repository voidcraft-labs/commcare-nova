/** Fresh-state, per-setting planners for the enabled Search settings bag. */

import {
	enableCaseSearchMutation,
	removeCaseSearchConfigIfNoAuthoredSettingsMutation,
	setOwnerOnlyCaseSearchMutation,
} from "@/lib/doc/caseSearchConfigMutations";
import { deepEqual } from "@/lib/doc/deepEqual";
import type { Mutation } from "@/lib/doc/types";
import {
	type CaseSearchConfig,
	isOwnerOnlyCaseSearchConfig,
	type OrdinaryCaseSearchConfig,
	type Uuid,
} from "@/lib/domain";

type UpdateModuleMutation = Extract<Mutation, { kind: "updateModule" }>;
type CaseSearchConfigPatch = NonNullable<
	UpdateModuleMutation["caseSearchConfigPatch"]
>;

const SETTINGS = [
	"excludedOwnerIds",
	"searchScreenTitle",
	"searchScreenSubtitle",
	"searchButtonLabel",
	"searchButtonDisplayCondition",
	"searchFirst",
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
