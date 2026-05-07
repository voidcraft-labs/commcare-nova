/**
 * SA tool: `setCaseListSort` — replace the multi-key sort list on
 * a module's case list.
 *
 * Accepts the typed `SortKey[]` shape directly. Each `SortKey`
 * carries a `source` (a property reference or a calculated column
 * id) plus a comparator type and direction. The runtime applies
 * keys in declaration order — the first is the primary sort, each
 * subsequent key acts as a tiebreaker.
 *
 * Wholesale replacement: the supplied array fully replaces the
 * module's `caseListConfig.sort` slot. An empty array clears the
 * sort entirely (case list renders in default insertion order).
 *
 * Both the SA chat factory and the MCP adapter call this through
 * the shared `ToolExecutionContext` interface. Two exit branches:
 *
 *   1. Module index out of range → `{ error }`, no mutations.
 *   2. Success → human-readable summary, tagged `module:M:sort`.
 */

import { z } from "zod";
import { type BlueprintDoc, sortKeySchema } from "@/lib/domain";
import { updateModuleMutations } from "../../blueprintHelpers";
import type { ToolExecutionContext } from "../../toolExecutionContext";
import { applyToDoc, type MutatingToolResult } from "../common";
import { baseCaseListConfig } from "./shared";

export const setCaseListSortInputSchema = z.object({
	moduleIndex: z
		.number()
		.describe("0-based module index whose case list sort to replace"),
	sort: z
		.array(sortKeySchema)
		.describe(
			"Replacement sort key list. Each `SortKey` carries a `source` (property reference or calculated column id), a comparator `type` (plain / date / integer / decimal), and a `direction` (asc / desc). The runtime applies keys in declaration order — the first is the primary sort; each subsequent key is a tiebreaker. An empty array clears the sort entirely.",
		),
});

export type SetCaseListSortInput = z.infer<typeof setCaseListSortInputSchema>;

/** Human-readable success string or an error record. */
export type SetCaseListSortResult = string | { error: string };

export const setCaseListSortTool = {
	description:
		"Replace the case list sort key list on a module with a typed SortKey AST array. Sort keys apply in order: first is primary, subsequent keys are tiebreakers. Pass an empty array to clear the sort.",
	inputSchema: setCaseListSortInputSchema,
	async execute(
		input: SetCaseListSortInput,
		ctx: ToolExecutionContext,
		doc: BlueprintDoc,
	): Promise<MutatingToolResult<SetCaseListSortResult>> {
		const { moduleIndex, sort } = input;
		try {
			const moduleUuid = doc.moduleOrder[moduleIndex];
			if (!moduleUuid) {
				return {
					kind: "mutate" as const,
					mutations: [],
					newDoc: doc,
					result: { error: `Module ${moduleIndex} not found` },
				};
			}
			const mod = doc.modules[moduleUuid];
			if (!mod) {
				return {
					kind: "mutate" as const,
					mutations: [],
					newDoc: doc,
					result: { error: `Module ${moduleIndex} not found` },
				};
			}

			// Preserve every other slot of the case-list config; only
			// the `sort` array is being replaced.
			const base = baseCaseListConfig(mod);
			const mutations = updateModuleMutations(doc, moduleUuid, {
				caseListConfig: { ...base, sort },
			});
			const newDoc = applyToDoc(doc, mutations);
			await ctx.recordMutations(
				mutations,
				newDoc,
				`module:${moduleIndex}:sort`,
			);

			return {
				kind: "mutate" as const,
				mutations,
				newDoc,
				result: `Successfully set ${sort.length} sort key${sort.length === 1 ? "" : "s"} on module "${mod.name}" (index ${moduleIndex}).`,
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
