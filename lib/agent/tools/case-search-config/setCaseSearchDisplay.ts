/**
 * SA tool: `setCaseSearchDisplay` — set the display cluster of a
 * module's case-search config (search-screen labels + the search-
 * button display predicate).
 *
 * Wholesale-with-`null`-clears: every slot is required-and-nullable
 * on the SA boundary; `null` clears, non-null sets. Mirrors
 * `setCaseListFilter`. The advanced cluster round-trips byte-identically
 * (harvested via `pickAdvancedCluster`).
 *
 * Two exit branches: module-index-out-of-range returns `{ error }`
 * with no mutations; success returns `{ message, displaySlotsSet }`
 * with the persisted mutation tagged `module:M:caseSearch:display`.
 */

import { z } from "zod";
import type { BlueprintDoc, CaseSearchConfig } from "@/lib/domain";
import { updateModuleMutations } from "../../blueprintHelpers";
import type { ToolExecutionContext } from "../../toolExecutionContext";
import { applyToDoc, type MutatingToolResult } from "../common";
import { moduleNotFoundResult } from "../shared/moduleNotFoundResult";
import type { ToolCallSummary } from "../shared/toolCallSummary";
import {
	applyClusterPatch,
	DISPLAY_SLOT_NAMES,
	type DisplaySlotName,
	pickAdvancedCluster,
	setCaseSearchDisplayBodySchema,
	slotsSetByInput,
	snapshotCaseSearchConfig,
} from "./shared";

export const setCaseSearchDisplayInputSchema = z
	.object({
		moduleIndex: z
			.number()
			.describe(
				"0-based module index whose case-search display cluster to set",
			),
	})
	.extend(setCaseSearchDisplayBodySchema.shape)
	.strict();

export type SetCaseSearchDisplayInput = z.infer<
	typeof setCaseSearchDisplayInputSchema
>;

/**
 * Success result. `displaySlotsSet` is the structured discriminator
 * the SA reads to confirm which slots landed non-null without re-
 * parsing the prose message; empty array means every display slot
 * was cleared.
 */
export interface SetCaseSearchDisplaySuccess {
	message: string;
	displaySlotsSet: readonly DisplaySlotName[];
	summary: ToolCallSummary;
}

export type SetCaseSearchDisplayResult =
	| SetCaseSearchDisplaySuccess
	| { error: string };

export const setCaseSearchDisplayTool = {
	description:
		"Set the display cluster of a module's case-search config: search-screen title + search-screen subtitle + search button label + the search-button display predicate. Pass `null` on any slot to clear it. The advanced cluster (niche search-side filters; the `excludedOwnerIds` expression) is not touched — use setCaseSearchAdvanced for that.",
	inputSchema: setCaseSearchDisplayInputSchema,
	async execute(
		input: SetCaseSearchDisplayInput,
		ctx: ToolExecutionContext,
		doc: BlueprintDoc,
	): Promise<MutatingToolResult<SetCaseSearchDisplayResult>> {
		const { moduleIndex } = input;
		try {
			const moduleUuid = doc.moduleOrder[moduleIndex];
			if (!moduleUuid)
				return moduleNotFoundResult<SetCaseSearchDisplaySuccess>(
					doc,
					moduleIndex,
					"set the case-search display cluster",
				);
			const mod = doc.modules[moduleUuid];
			if (!mod)
				return moduleNotFoundResult<SetCaseSearchDisplaySuccess>(
					doc,
					moduleIndex,
					"set the case-search display cluster",
				);

			// Preserve the advanced cluster, layer the display patch on
			// top. Both halves key off the same slot tuples; partition
			// assertions in `shared.ts` catch cluster-home omissions at
			// compile time.
			const existing = snapshotCaseSearchConfig(mod);
			const nextConfig: CaseSearchConfig = {
				...pickAdvancedCluster(existing),
				...applyClusterPatch(input, DISPLAY_SLOT_NAMES),
			};

			const mutations = updateModuleMutations(mod, {
				caseSearchConfig: nextConfig,
			});
			const newDoc = applyToDoc(doc, mutations);
			await ctx.recordMutations(
				mutations,
				newDoc,
				`module:${moduleIndex}:caseSearch:display`,
			);

			// Derive the message from the same slot tuple. A new entry
			// on `DISPLAY_SLOT_NAMES` flows through verbatim.
			const displaySlotsSet = slotsSetByInput(input, DISPLAY_SLOT_NAMES);

			return {
				kind: "mutate" as const,
				mutations,
				newDoc,
				result: {
					message:
						displaySlotsSet.length === 0
							? `Cleared every case-search display slot on module "${mod.name}" (index ${moduleIndex}).`
							: `Set case-search display on module "${mod.name}" (index ${moduleIndex}): ${displaySlotsSet.join(", ")}.`,
					displaySlotsSet,
					summary: { location: mod.name },
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
