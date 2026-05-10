/**
 * SA tool: `setCaseSearchAdvanced` — set the advanced cluster of a
 * module's case-search config in one call.
 *
 * The case-search config carries two independent clusters; this tool
 * owns the advanced cluster — niche search-side filters most authors
 * never reach for. The cluster carries the `excludedOwnerIds` slot.
 * The abstract framing scopes the tool to the cluster's role (niche
 * filters), not its contents. Display labels stay untouched and
 * round-trip byte-identically through the patch — the tool harvests
 * them via `pickDisplayCluster` and layers the input's advanced values
 * on top. The display tool (`setCaseSearchDisplay`) is the parallel for
 * the other cluster.
 *
 * Wholesale-with-`null`-clears semantic — every cluster slot is
 * required-and-nullable on the SA boundary; `null` clears, non-null
 * sets. Mirrors `setCaseListFilter`.
 *
 * Both the SA chat factory and the MCP adapter call this through the
 * shared `ToolExecutionContext` interface. Two exit branches:
 *
 *   1. Module index out of range → `{ error }`, no mutations.
 *   2. Success → `{ message, advancedSlotsSet }` plus the persisted
 *      mutation, tagged `module:M:caseSearch:advanced`.
 */

import { z } from "zod";
import type { BlueprintDoc, CaseSearchConfig } from "@/lib/domain";
import { updateModuleMutations } from "../../blueprintHelpers";
import type { ToolExecutionContext } from "../../toolExecutionContext";
import { applyToDoc, type MutatingToolResult } from "../common";
import { moduleNotFoundResult } from "../shared/moduleNotFoundResult";
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
 * Success result for `setCaseSearchAdvanced`. `advancedSlotsSet` is
 * the structured discriminator the SA reads to confirm which slots
 * received a non-null value on this call, mirroring the parallel
 * `displaySlotsSet` field on `setCaseSearchDisplay` and removing the
 * need to re-parse the prose message. Empty array means every
 * advanced slot was cleared.
 */
export interface SetCaseSearchAdvancedSuccess {
	message: string;
	advancedSlotsSet: readonly AdvancedSlotName[];
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

			// Carry the display cluster forward via the shared picker,
			// then layer the input's advanced values on top via the
			// shared cluster-patch helper. Both halves derive their
			// slot sets from the same source-of-truth tuples the input
			// schema uses; the partition assertions in `shared.ts`
			// catch any cluster-home omission at compile time.
			const existing = snapshotCaseSearchConfig(mod);
			const nextConfig: CaseSearchConfig = {
				...pickDisplayCluster(existing),
				...applyClusterPatch(input, ADVANCED_SLOT_NAMES),
			};

			const mutations = updateModuleMutations(mod, {
				caseSearchConfig: nextConfig,
			});
			const newDoc = applyToDoc(doc, mutations);
			await ctx.recordMutations(
				mutations,
				newDoc,
				`module:${moduleIndex}:caseSearch:advanced`,
			);

			// Derive the message from the same slot tuple `applyClusterPatch`
			// projects against. A new entry on `ADVANCED_SLOT_NAMES`
			// flows into the message verbatim — no per-slot literal in
			// the tool body to keep in lockstep.
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
