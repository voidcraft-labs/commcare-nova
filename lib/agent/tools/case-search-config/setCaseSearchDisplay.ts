/**
 * SA tool: `setCaseSearchDisplay` — set the display cluster of a
 * module's case-search config in one call.
 *
 * The case-search config carries two independent clusters; this tool
 * owns the display cluster (search-screen labels + the search-button
 * display predicate). The advanced cluster (niche search-side filters
 * — today the blacklisted owner ids expression) stays untouched and
 * round-trips byte-identically through the patch. The advanced tool
 * (`setCaseSearchAdvanced`) is the parallel for the other cluster.
 *
 * Wholesale-with-`null`-clears semantic — every display slot is
 * required-and-nullable on the SA boundary; `null` clears, non-null
 * sets. Mirrors `setCaseListFilter`.
 *
 * Both the SA chat factory and the MCP adapter call this through the
 * shared `ToolExecutionContext` interface. Two exit branches:
 *
 *   1. Module index out of range → `{ error }`, no mutations.
 *   2. Success → `{ message, displaySlotsSet }` plus the persisted
 *      mutation, tagged `module:M:caseSearch:display`.
 */

import { z } from "zod";
import type { BlueprintDoc, CaseSearchConfig } from "@/lib/domain";
import { updateModuleMutations } from "../../blueprintHelpers";
import type { ToolExecutionContext } from "../../toolExecutionContext";
import { applyToDoc, type MutatingToolResult } from "../common";
import { moduleNotFoundResult } from "../shared/moduleNotFoundResult";
import {
	DISPLAY_SLOT_NAMES,
	type DisplaySlotName,
	pickAdvancedCluster,
	setCaseSearchDisplayBodySchema,
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
 * Success result. `displaySlotsSet` is the discriminator the SA reads
 * to confirm which slots received a non-null value on this call,
 * mirroring the `kind`-discriminator pattern on `setCaseListFilter`.
 * Empty array means every display slot was cleared.
 */
export interface SetCaseSearchDisplaySuccess {
	message: string;
	displaySlotsSet: readonly DisplaySlotName[];
}

export type SetCaseSearchDisplayResult =
	| SetCaseSearchDisplaySuccess
	| { error: string };

export const setCaseSearchDisplayTool = {
	description:
		"Set the display cluster of a module's case-search config: search-screen title + subtitle + empty-list text + search button labels + the search-button display predicate. Pass `null` on any slot to clear it. The advanced cluster (niche search-side filters, today the blacklisted owner ids expression) is not touched — use setCaseSearchAdvanced for that.",
	inputSchema: setCaseSearchDisplayInputSchema,
	async execute(
		input: SetCaseSearchDisplayInput,
		ctx: ToolExecutionContext,
		doc: BlueprintDoc,
	): Promise<MutatingToolResult<SetCaseSearchDisplayResult>> {
		const {
			moduleIndex,
			searchScreenTitle,
			searchScreenSubtitle,
			emptyListText,
			searchButtonLabel,
			searchAgainButtonLabel,
			searchButtonDisplayCondition,
		} = input;
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

			// Carry the advanced cluster forward via the shared picker,
			// then layer the input's display values on top. The picker
			// reads from the same source-of-truth tuples the input
			// schema derives from, so a future schema slot that lands
			// on the advanced cluster preserves automatically.
			const existing = snapshotCaseSearchConfig(mod);
			const nextConfig: CaseSearchConfig = {
				...pickAdvancedCluster(existing),
				...(searchScreenTitle !== null && { searchScreenTitle }),
				...(searchScreenSubtitle !== null && { searchScreenSubtitle }),
				...(emptyListText !== null && { emptyListText }),
				...(searchButtonLabel !== null && { searchButtonLabel }),
				...(searchAgainButtonLabel !== null && { searchAgainButtonLabel }),
				...(searchButtonDisplayCondition !== null && {
					searchButtonDisplayCondition,
				}),
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

			// Surface which display slots landed non-null so the SA reads
			// the outcome without re-parsing prose. The slot list mirrors
			// `DISPLAY_SLOT_NAMES`; values are looked up off the typed
			// input record so a future slot rename surfaces at compile
			// time.
			const supplied: Record<DisplaySlotName, unknown> = {
				searchScreenTitle,
				searchScreenSubtitle,
				emptyListText,
				searchButtonLabel,
				searchAgainButtonLabel,
				searchButtonDisplayCondition,
			};
			const displaySlotsSet = DISPLAY_SLOT_NAMES.filter(
				(slot) => supplied[slot] !== null,
			);

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
