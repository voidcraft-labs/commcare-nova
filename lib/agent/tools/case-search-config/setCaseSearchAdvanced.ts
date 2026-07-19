/**
 * SA tool: `setCaseSearchAdvanced` — set the advanced cluster of a
 * module's case-search config (today, the rare owner-availability
 * `excludedOwnerIds` slot). The value is global: it may read session/current-
 * user values and Search answers, but never a case property or relationship
 * because it resolves before a case is selected.
 *
 * Every slot is required-and-nullable on the SA boundary: `null` clears,
 * non-null sets. The tool computes a whole editor projection so the display
 * cluster round-trips byte-identically, then `updateModuleMutations` splits
 * it into fresh-state per-slot writes; its whole-config payload is only the
 * rolling-deploy fallback.
 *
 * Two exit branches: module-index-out-of-range returns `{ error }`
 * with no mutations; success returns `{ message, advancedSlotsSet }`
 * with the persisted mutation tagged `module:M:caseSearch:advanced`.
 */

import { z } from "zod";
import type { BlueprintDoc, CaseSearchConfig } from "@/lib/domain";
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
import { moduleNotFoundResult } from "../shared/moduleNotFoundResult";
import type { ToolCallSummary } from "../shared/toolCallSummary";
import {
	ADVANCED_SLOT_NAMES,
	type AdvancedSlotName,
	applyClusterPatch,
	collapseUnauthoredCaseSearchConfig,
	pickDisplayCluster,
	pickSearchActionIntent,
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
		"Set a module's rare owner-availability rule (excludedOwnerIds). The value can use fixed owner ids, current-user/session values, or Search answers, but not case properties or relationships; null clears it. Search action text lives on setCaseSearchDisplay.",
	inputSchema: setCaseSearchAdvancedInputSchema,
	async execute(
		input: SetCaseSearchAdvancedInput,
		ctx: ToolExecutionContext,
		doc: BlueprintDoc,
	): Promise<MutatingToolResult<SetCaseSearchAdvancedResult>> {
		const { moduleIndex } = input;
		try {
			const moduleUuid = resolveModuleUuid(doc, moduleIndex);
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
			const advancedPatch = applyClusterPatch(input, ADVANCED_SLOT_NAMES);
			const addingFirstOwnerRule =
				existing === undefined &&
				(mod.caseListConfig?.searchInputs.length ?? 0) === 0 &&
				advancedPatch.excludedOwnerIds !== undefined;
			const nextConfigCandidate: CaseSearchConfig = {
				...pickDisplayCluster(existing),
				...(addingFirstOwnerRule
					? { searchActionEnabled: false as const }
					: pickSearchActionIntent(existing)),
				...advancedPatch,
			};
			const nextConfig = collapseUnauthoredCaseSearchConfig(
				existing,
				nextConfigCandidate,
			);

			const mutations = updateModuleMutations(mod, {
				caseSearchConfig: nextConfig ?? null,
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
			return toToolErrorResult(err, doc);
		}
	},
};
