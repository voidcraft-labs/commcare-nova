/**
 * SA tool: `setCaseSearchAdvanced` — set the advanced cluster of a
 * module's case-search config in one call.
 *
 * The case-search config carries two independent clusters; this tool
 * owns the advanced cluster — niche search-side filters most authors
 * never reach for. Today the cluster holds a single slot
 * (`blacklistedOwnerIds`). Display labels stay untouched and round-
 * trip byte-identically through the patch — the tool reads the
 * existing config, strips the advanced keys, and rebuilds with the
 * input. The display tool (`setCaseSearchDisplay`) is the parallel
 * for the other cluster.
 *
 * Wholesale-with-`null`-clears semantic — every cluster slot is
 * required-and-nullable on the SA boundary; `null` clears, non-null
 * sets. Mirrors `setCaseListFilter`.
 *
 * Both the SA chat factory and the MCP adapter call this through the
 * shared `ToolExecutionContext` interface. Two exit branches:
 *
 *   1. Module index out of range → `{ error }`, no mutations.
 *   2. Success → `{ message }` plus the persisted mutation, tagged
 *      `module:M:caseSearch:advanced`.
 */

import { z } from "zod";
import type { BlueprintDoc, CaseSearchConfig } from "@/lib/domain";
import { updateModuleMutations } from "../../blueprintHelpers";
import type { ToolExecutionContext } from "../../toolExecutionContext";
import { applyToDoc, type MutatingToolResult } from "../common";
import { moduleNotFoundResult } from "../shared/moduleNotFoundResult";
import {
	setCaseSearchAdvancedBodySchema,
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
 * Success result for `setCaseSearchAdvanced`. Single-slot wholesale
 * tools don't carry a `kind`-discriminator the way the display tool's
 * `displaySlotsSet` array discriminator does — there's no useful
 * branching for the SA off "blacklist set vs cleared" beyond what
 * the prose message already conveys.
 */
export interface SetCaseSearchAdvancedSuccess {
	message: string;
}

export type SetCaseSearchAdvancedResult =
	| SetCaseSearchAdvancedSuccess
	| { error: string };

export const setCaseSearchAdvancedTool = {
	description:
		"Set the advanced cluster of a module's case-search config: niche search-side filters most authors never reach for. Today the cluster holds the blacklisted owner ids expression — pass `null` for `blacklistedOwnerIds` to clear that slot. The display cluster (search-screen labels) is not touched — use setCaseSearchDisplay for that.",
	inputSchema: setCaseSearchAdvancedInputSchema,
	async execute(
		input: SetCaseSearchAdvancedInput,
		ctx: ToolExecutionContext,
		doc: BlueprintDoc,
	): Promise<MutatingToolResult<SetCaseSearchAdvancedResult>> {
		const { moduleIndex, blacklistedOwnerIds } = input;
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

			// Strip the advanced cluster's keys from the snapshot so the
			// rebuild below carries only the display cluster forward —
			// then layer the input's advanced values back on. Display
			// slots (`searchScreenTitle`, button labels, search-button
			// display predicate) are untouched, matching the per-tool
			// cluster boundary the SA expects.
			const existing = snapshotCaseSearchConfig(mod);
			const { blacklistedOwnerIds: _existingBlacklist, ...displayCluster } =
				existing ?? {};
			const nextConfig: CaseSearchConfig = {
				...displayCluster,
				...(blacklistedOwnerIds !== null && { blacklistedOwnerIds }),
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

			return {
				kind: "mutate" as const,
				mutations,
				newDoc,
				result: {
					message:
						blacklistedOwnerIds === null
							? `Set case-search advanced on module "${mod.name}" (index ${moduleIndex}): blacklisted owner ids cleared.`
							: `Set case-search advanced on module "${mod.name}" (index ${moduleIndex}): blacklisted owner ids set.`,
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
