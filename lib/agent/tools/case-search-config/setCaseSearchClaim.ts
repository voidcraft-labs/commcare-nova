/**
 * SA tool: `setCaseSearchClaim` — set the claim cluster of a module's
 * case-search config in one call.
 *
 * The case-search config carries two independent clusters; this tool
 * owns the claim cluster (claim condition / blacklisted owner ids).
 * Display labels stay untouched and round-trip byte-identically
 * through the patch — the tool reads the existing config, strips
 * the claim keys, and rebuilds with the input. The display tool
 * (`setCaseSearchDisplay`) is the parallel for the other cluster.
 *
 * Wholesale-with-`null`-clears semantic — every cluster slot is
 * required-and-nullable on the SA boundary; `null` clears, non-null
 * sets. Mirrors `setCaseListFilter`.
 *
 * Both the SA chat factory and the MCP adapter call this through the
 * shared `ToolExecutionContext` interface. Two exit branches:
 *
 *   1. Module index out of range → `{ error }`, no mutations.
 *   2. Success → `{ message, claimConditionKind }` plus the persisted
 *      mutation, tagged `module:M:caseSearch:claim`.
 */

import { z } from "zod";
import type { BlueprintDoc, CaseSearchConfig } from "@/lib/domain";
import type { Predicate } from "@/lib/domain/predicate";
import { updateModuleMutations } from "../../blueprintHelpers";
import type { ToolExecutionContext } from "../../toolExecutionContext";
import { applyToDoc, type MutatingToolResult } from "../common";
import { moduleNotFoundResult } from "../shared/moduleNotFoundResult";
import {
	setCaseSearchClaimBodySchema,
	snapshotCaseSearchConfig,
} from "./shared";

export const setCaseSearchClaimInputSchema = z
	.object({
		moduleIndex: z
			.number()
			.describe("0-based module index whose case-search claim cluster to set"),
	})
	.extend(setCaseSearchClaimBodySchema.shape)
	.strict();

export type SetCaseSearchClaimInput = z.infer<
	typeof setCaseSearchClaimInputSchema
>;

/**
 * Discriminator returned in the structured success arm. Surfaces the
 * shape of the supplied claim condition so the SA branches on the
 * outcome without re-parsing the prose message — `cleared` on a
 * `null` claim, the predicate's `kind` otherwise. Mirrors
 * `SetCaseListFilterKind`.
 */
export type SetCaseSearchClaimConditionKind = Predicate["kind"] | "cleared";

/**
 * Success result for `setCaseSearchClaim`. `claimConditionKind` carries
 * the supplied predicate's discriminator (or `"cleared"` on the null-
 * clears path).
 */
export interface SetCaseSearchClaimSuccess {
	message: string;
	claimConditionKind: SetCaseSearchClaimConditionKind;
}

export type SetCaseSearchClaimResult =
	| SetCaseSearchClaimSuccess
	| { error: string };

export const setCaseSearchClaimTool = {
	description:
		"Set the claim cluster of a module's case-search config: the claim condition predicate and the blacklisted owner ids expression. Pass `null` for `claimCondition` or `blacklistedOwnerIds` to clear that slot. The display cluster (search-screen labels) is not touched — use setCaseSearchDisplay for that.",
	inputSchema: setCaseSearchClaimInputSchema,
	async execute(
		input: SetCaseSearchClaimInput,
		ctx: ToolExecutionContext,
		doc: BlueprintDoc,
	): Promise<MutatingToolResult<SetCaseSearchClaimResult>> {
		const { moduleIndex, claimCondition, blacklistedOwnerIds } = input;
		try {
			const moduleUuid = doc.moduleOrder[moduleIndex];
			if (!moduleUuid)
				return moduleNotFoundResult<SetCaseSearchClaimSuccess>(
					doc,
					moduleIndex,
					"set the case-search claim",
				);
			const mod = doc.modules[moduleUuid];
			if (!mod)
				return moduleNotFoundResult<SetCaseSearchClaimSuccess>(
					doc,
					moduleIndex,
					"set the case-search claim",
				);

			// Strip the claim cluster's keys from the snapshot so the
			// rebuild below carries only the display cluster forward —
			// then layer the input's claim values back on. Display slots
			// (`searchScreenTitle`, button labels, search-button display
			// predicate) are untouched, matching the per-tool cluster
			// boundary the SA expects.
			const existing = snapshotCaseSearchConfig(mod);
			const {
				claimCondition: _existingCondition,
				blacklistedOwnerIds: _existingBlacklist,
				...displayCluster
			} = existing ?? {};
			const nextConfig: CaseSearchConfig = {
				...displayCluster,
				...(claimCondition !== null && { claimCondition }),
				...(blacklistedOwnerIds !== null && { blacklistedOwnerIds }),
			};

			const mutations = updateModuleMutations(mod, {
				caseSearchConfig: nextConfig,
			});
			const newDoc = applyToDoc(doc, mutations);
			await ctx.recordMutations(
				mutations,
				newDoc,
				`module:${moduleIndex}:caseSearch:claim`,
			);

			return {
				kind: "mutate" as const,
				mutations,
				newDoc,
				result: {
					message:
						claimCondition === null
							? `Set case-search claim on module "${mod.name}" (index ${moduleIndex}): no claim condition.`
							: `Set case-search claim on module "${mod.name}" (index ${moduleIndex}): claim condition kind=${claimCondition.kind}.`,
					claimConditionKind:
						claimCondition === null ? "cleared" : claimCondition.kind,
				},
			};
		} catch (err) {
			return {
				kind: "mutate" as const,
				mutations: [],
				newDoc: doc,
				result: { error: err instanceof Error ? err.message : String(err) },
			};
		}
	},
};
