/**
 * SA tool: `setCaseSearchDisplay` — set the display cluster of a
 * module's case-search config (search-screen labels + the search-
 * button display predicate).
 *
 * Every slot is required-and-nullable on the SA boundary: `null` clears,
 * non-null sets. The tool computes a whole editor projection so the advanced
 * cluster round-trips byte-identically, then `updateModuleMutations` splits
 * it into fresh-state per-slot writes; its whole-config payload is only the
 * rolling-deploy fallback.
 *
 * Two exit branches: module-index-out-of-range returns `{ error }`
 * with no mutations; success returns `{ message, displaySlotsSet }`
 * with the persisted mutation tagged `module:M:caseSearch:display`.
 */

import { z } from "zod";
import {
	type BlueprintDoc,
	type CaseSearchConfig,
	caseSearchConfigHasAuthoredSettings,
} from "@/lib/domain";
import {
	resolveModuleUuid,
	updateModuleMutations,
} from "../../blueprintHelpers";
import type { ToolExecutionContext } from "../../toolExecutionContext";
import {
	guardedMutate,
	type MutatingToolResult,
	toToolErrorResult,
} from "../common";
import { canonicalizePredicateCaseProperties } from "../shared/canonicalCaseProperties";
import { moduleNotFoundResult } from "../shared/moduleNotFoundResult";
import type { ToolCallSummary } from "../shared/toolCallSummary";
import {
	applyClusterPatch,
	DISPLAY_SLOT_NAMES,
	type DisplaySlotName,
	pickAdvancedCluster,
	pickSearchActionIntent,
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
		"Set a module's case-search display cluster: screen title, subtitle, button label, button display predicate. null clears a slot. Advanced filters live on setCaseSearchAdvanced.",
	inputSchema: setCaseSearchDisplayInputSchema,
	async execute(
		input: SetCaseSearchDisplayInput,
		ctx: ToolExecutionContext,
		doc: BlueprintDoc,
	): Promise<MutatingToolResult<SetCaseSearchDisplayResult>> {
		const { moduleIndex } = input;
		try {
			const moduleUuid = resolveModuleUuid(doc, moduleIndex);
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
			const displayPatch = applyClusterPatch(input, DISPLAY_SLOT_NAMES);
			if (displayPatch.searchButtonDisplayCondition !== undefined) {
				displayPatch.searchButtonDisplayCondition =
					canonicalizePredicateCaseProperties(
						displayPatch.searchButtonDisplayCondition,
					);
			}
			const authoredDisplaySetting = Object.keys(displayPatch).length > 0;
			const nextConfigCandidate: CaseSearchConfig = {
				...pickAdvancedCluster(existing),
				...(!authoredDisplaySetting && pickSearchActionIntent(existing)),
				...displayPatch,
			};
			const nextConfig =
				(existing === undefined ||
					nextConfigCandidate.searchActionEnabled === false) &&
				!caseSearchConfigHasAuthoredSettings(nextConfigCandidate)
					? undefined
					: nextConfigCandidate;

			const mutations = updateModuleMutations(mod, {
				caseSearchConfig: nextConfig ?? null,
			});
			const commit = await guardedMutate(
				ctx,
				doc,
				mutations,
				`module:${moduleIndex}:caseSearch:display`,
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
			return toToolErrorResult(err, doc);
		}
	},
};
