/** Shared generic module-patch planner for builder and SA/MCP surfaces. */

import { updateModuleMutation } from "@/lib/doc/addModuleMutation";
import {
	caseSearchConfigPatchMutations,
	clearCaseSearchConfigSettingsMutations,
} from "@/lib/doc/caseSearchConfigPatchMutations";
import type { Mutation } from "@/lib/doc/types";
import type { Module } from "@/lib/domain";

type ModulePatch = Extract<Mutation, { kind: "updateModule" }>["patch"];

/**
 * Split a generic module edit into one old-compatible metadata/config patch
 * plus fresh-state per-slot Search mutations. `caseListConfig` sanitization is
 * delegated to `updateModuleMutation`; Search settings never ride that whole
 * bag on current receivers.
 */
export function modulePatchMutations(
	mod: Module,
	patch: ModulePatch,
	options: { readonly nullCaseSearchConfig?: "replace" | "settings" } = {},
): Mutation[] {
	if (!Object.hasOwn(patch, "caseSearchConfig")) {
		return [updateModuleMutation(mod.uuid, patch)];
	}
	const { caseSearchConfig, ...other } = patch;
	const mutations: Mutation[] =
		Object.keys(other).length > 0
			? [updateModuleMutation(mod.uuid, other)]
			: [];
	if (caseSearchConfig === null || caseSearchConfig === undefined) {
		if (options.nullCaseSearchConfig === "settings") {
			mutations.push(
				...clearCaseSearchConfigSettingsMutations(
					mod.uuid,
					mod.caseSearchConfig,
				),
			);
		} else {
			mutations.push(
				updateModuleMutation(mod.uuid, {
					caseSearchConfig: caseSearchConfig ?? null,
				}),
			);
		}
		return mutations;
	}
	mutations.push(
		...caseSearchConfigPatchMutations(
			mod.uuid,
			mod.caseSearchConfig,
			caseSearchConfig,
		),
	);
	return mutations;
}
