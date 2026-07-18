/** Fresh-state, per-setting planners for the enabled Search settings bag. */

import {
	enableCaseSearchMutation,
	removeCaseSearchConfigIfNoAuthoredSettingsMutation,
	setOwnerOnlyCaseSearchMutation,
} from "@/lib/doc/caseSearchConfigMutations";
import type { Mutation } from "@/lib/doc/types";
import {
	type CaseSearchConfig,
	normalizeOwnerOnlyCaseSearchConfig,
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
] as const satisfies readonly (keyof CaseSearchConfigPatch)[];

/**
 * Plan one whole editor projection as independent setting writes. A local
 * whole-bag snapshot remains only as the pre-deploy reducer fallback; current
 * receivers apply `caseSearchConfigPatch` to fresh state so title, button,
 * condition, and owner edits commute.
 */
export function caseSearchConfigPatchMutations(
	uuid: Uuid,
	current: CaseSearchConfig | undefined,
	next: CaseSearchConfig,
): Mutation[] {
	if (next.searchActionEnabled === false) {
		return [setOwnerOnlyCaseSearchMutation(uuid, next)];
	}

	const normalizedCurrent =
		current === undefined
			? undefined
			: normalizeOwnerOnlyCaseSearchConfig(current);
	const currentEnabled = normalizedCurrent?.searchActionEnabled !== false;
	const baseline: CaseSearchConfig =
		normalizedCurrent === undefined
			? {}
			: (() => {
					const { searchActionEnabled: _intent, ...enabled } =
						normalizedCurrent;
					return enabled;
				})();
	const desired = structuredClone(next);
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
			patch: { caseSearchConfig: desired },
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
	const normalized = normalizeOwnerOnlyCaseSearchConfig(current);
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
			patch: { caseSearchConfig: null },
			caseSearchConfigPatch: patch,
		});
	}
	mutations.push(removeCaseSearchConfigIfNoAuthoredSettingsMutation(uuid));
	return mutations;
}

function deepEqual(a: unknown, b: unknown): boolean {
	if (a === b) return true;
	if (a === null || b === null) return false;
	if (typeof a !== "object" || typeof b !== "object") return false;
	const aArray = Array.isArray(a);
	const bArray = Array.isArray(b);
	if (aArray !== bArray) return false;
	if (aArray && bArray) {
		if (a.length !== b.length) return false;
		return a.every((value, index) => deepEqual(value, b[index]));
	}
	const aObject = a as Record<string, unknown>;
	const bObject = b as Record<string, unknown>;
	const aKeys = Object.keys(aObject);
	const bKeys = Object.keys(bObject);
	if (aKeys.length !== bKeys.length) return false;
	return aKeys.every(
		(key) =>
			Object.hasOwn(bObject, key) && deepEqual(aObject[key], bObject[key]),
	);
}
