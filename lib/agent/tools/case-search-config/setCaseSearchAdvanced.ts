/**
 * SA tool: `setCaseSearchAdvanced` — set the advanced cluster of a
 * module's case-search config (the niche search-side filters most
 * authors never reach for; today, the `excludedOwnerIds` slot).
 *
 * Wholesale-with-`null`-clears: every slot is required-and-nullable
 * on the SA boundary; `null` clears, non-null sets. Mirrors
 * `setCaseListFilter`. The display cluster round-trips byte-identically
 * (harvested via `pickDisplayCluster`).
 *
 * Two exit branches: module-index-out-of-range returns `{ error }`
 * with no mutations; success returns `{ message, advancedSlotsSet }`
 * with the persisted mutation tagged `module:M:caseSearch:advanced`.
 */

import { z } from "zod";
import type { BlueprintDoc, CaseSearchConfig } from "@/lib/domain";
import { updateModuleMutations } from "../../blueprintHelpers";
import type { ToolExecutionContext } from "../../toolExecutionContext";
import { guardedMutate, type MutatingToolResult } from "../common";
import { moduleNotFoundResult } from "../shared/moduleNotFoundResult";
import type { ToolCallSummary } from "../shared/toolCallSummary";
import {
	ADVANCED_SLOT_NAMES,
	type AdvancedSlotName,
	applyClusterPatch,
	pickDisplayCluster,
	setCaseSearchAdvancedBodySchema,
	slotsSetByInput,
	snapshotCaseSearchConfig,
} from "./shared";

export const setCaseSearchAdvancedInputSchema = z
	.object({
		moduleIndex: z
			.number()
			.describe(
				"0-based module index whose case-search advanced cluster to set",
			),
	})
	.extend(setCaseSearchAdvancedBodySchema.shape)
	.strict();

export type SetCaseSearchAdvancedInput = z.infer<
	typeof setCaseSearchAdvancedInputSchema
>;

/**
 * Success result. `advancedSlotsSet` is the structured discriminator
 * the SA reads to confirm which slots landed non-null without re-
 * parsing the prose message; empty array means every advanced slot
 * was cleared.
 */
export interface SetCaseSearchAdvancedSuccess {
	message: string;
	advancedSlotsSet: readonly AdvancedSlotName[];
	summary: ToolCallSummary;
}

export type SetCaseSearchAdvancedResult =
	| SetCaseSearchAdvancedSuccess
	| { error: string };

export const setCaseSearchAdvancedTool = {
	description:
		"Set the advanced cluster of a module's case-search config: niche search-side filters most authors never reach for. The cluster carries a `excludedOwnerIds` expression — pass `null` to clear that slot. The display cluster (search-screen labels) is not touched — use setCaseSearchDisplay for that.",
	inputSchema: setCaseSearchAdvancedInputSchema,
	async execute(
		input: SetCaseSearchAdvancedInput,
		ctx: ToolExecutionContext,
		doc: BlueprintDoc,
	): Promise<MutatingToolResult<SetCaseSearchAdvancedResult>> {
		const { moduleIndex } = input;
		try {
			const moduleUuid = doc.moduleOrder[moduleIndex];
			if (!moduleUuid)
				return moduleNotFoundResult<SetCaseSearchAdvancedSuccess>(
					doc,
					moduleIndex,
					"set the case-search advanced cluster",
				);
			const mod = doc.modules[moduleUuid];
			if (!mod)
				return moduleNotFoundResult<SetCaseSearchAdvancedSuccess>(
					doc,
					moduleIndex,
					"set the case-search advanced cluster",
				);

			// Preserve the display cluster, layer the advanced patch on
			// top. Both halves key off the same slot tuples; partition
			// assertions in `shared.ts` catch cluster-home omissions at
			// compile time.
			const existing = snapshotCaseSearchConfig(mod);
			const nextConfig: CaseSearchConfig = {
				...pickDisplayCluster(existing),
				...applyClusterPatch(input, ADVANCED_SLOT_NAMES),
			};

			const mutations = updateModuleMutations(mod, {
				caseSearchConfig: nextConfig,
			});
			const commit = await guardedMutate(
				ctx,
				doc,
				mutations,
				`module:${moduleIndex}:caseSearch:advanced`,
			);
			if (!commit.ok) {
				return {
					kind: "mutate" as const,
					mutations: [],
					newDoc: doc,
					result: { error: commit.error },
				};
			}
			const newDoc = commit.newDoc;

			// Derive the message from the same slot tuple. A new entry
			// on `ADVANCED_SLOT_NAMES` flows through verbatim.
			const advancedSlotsSet = slotsSetByInput(input, ADVANCED_SLOT_NAMES);

			return {
				kind: "mutate" as const,
				mutations,
				newDoc,
				result: {
					message:
						advancedSlotsSet.length === 0
							? `Cleared every case-search advanced slot on module "${mod.name}" (index ${moduleIndex}).`
							: `Set case-search advanced on module "${mod.name}" (index ${moduleIndex}): ${advancedSlotsSet.join(", ")}.`,
					advancedSlotsSet,
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
