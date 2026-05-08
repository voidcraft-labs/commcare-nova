/**
 * SA tool: `removeSearchInput` — drop one search input from a module's
 * case list, keyed by `searchInputUuid`.
 *
 * Atomic op — removes ONE entry from `caseListConfig.searchInputs` and
 * preserves every other slot. Returns the removed uuid + the remaining
 * count so the SA confirms the edit landed on the right entry.
 *
 * Three exit branches:
 *
 *   1. Module index out of range → `{ error }`, no mutations.
 *   2. Search-input uuid not present → `{ error }`, no mutations.
 *   3. Success → `{ message, uuid, remaining }` plus the persisted
 *      mutation, tagged `module:M:caseList:searchInput:remove`.
 */

import { z } from "zod";
import { asUuid, type BlueprintDoc, type Uuid } from "@/lib/domain";
import { removeSearchInputMutation } from "../../blueprintHelpers";
import type { ToolExecutionContext } from "../../toolExecutionContext";
import { applyToDoc, type MutatingToolResult } from "../common";
import { uuidInputSchema } from "./shared";

export const removeSearchInputInputSchema = z.object({
	moduleIndex: z
		.number()
		.describe("0-based module index whose case list search input to remove"),
	searchInputUuid: uuidInputSchema.describe(
		"Uuid of the search input to remove. Look at getModule's projection or run searchBlueprint to surface the current uuids.",
	),
});

export type RemoveSearchInputInput = z.infer<
	typeof removeSearchInputInputSchema
>;

export interface RemoveSearchInputSuccess {
	message: string;
	uuid: Uuid;
	remaining: number;
}

export type RemoveSearchInputResult =
	| RemoveSearchInputSuccess
	| { error: string };

export const removeSearchInputTool = {
	description:
		"Remove one search input from a module's case list, keyed by searchInputUuid. Returns the remaining search-input count so the SA confirms the edit landed on the right entry.",
	inputSchema: removeSearchInputInputSchema,
	async execute(
		input: RemoveSearchInputInput,
		ctx: ToolExecutionContext,
		doc: BlueprintDoc,
	): Promise<MutatingToolResult<RemoveSearchInputResult>> {
		const { moduleIndex, searchInputUuid: rawSearchInputUuid } = input;
		const searchInputUuid = asUuid(rawSearchInputUuid);
		try {
			const moduleUuid = doc.moduleOrder[moduleIndex];
			if (!moduleUuid) return moduleNotFoundResult(doc, moduleIndex);
			const mod = doc.modules[moduleUuid];
			if (!mod) return moduleNotFoundResult(doc, moduleIndex);

			const result = removeSearchInputMutation(mod, searchInputUuid);
			if ("error" in result) {
				return {
					kind: "mutate" as const,
					mutations: [],
					newDoc: doc,
					result: { error: result.error },
				};
			}

			const newDoc = applyToDoc(doc, result.mutations);
			await ctx.recordMutations(
				result.mutations,
				newDoc,
				`module:${moduleIndex}:caseList:searchInput:remove`,
			);

			const remaining =
				newDoc.modules[moduleUuid]?.caseListConfig?.searchInputs.length ?? 0;
			return {
				kind: "mutate" as const,
				mutations: result.mutations,
				newDoc,
				result: {
					message: `Removed search input ${searchInputUuid} on module "${mod.name}". ${remaining} search input${remaining === 1 ? "" : "s"} remain.`,
					uuid: searchInputUuid,
					remaining,
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

function moduleNotFoundResult(
	doc: BlueprintDoc,
	moduleIndex: number,
): MutatingToolResult<RemoveSearchInputResult> {
	return {
		kind: "mutate" as const,
		mutations: [],
		newDoc: doc,
		result: {
			error: `Tried to remove a search input on module ${moduleIndex}. Found no module at that index. Look at getModule's projection for the available module indices.`,
		},
	};
}
