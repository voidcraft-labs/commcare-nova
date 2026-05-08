/**
 * SA tool: `reorderSearchInputs` — reorder the search-inputs array on
 * a module's case list.
 *
 * Atomic op — reorders `caseListConfig.searchInputs` in place and
 * preserves every other slot. The supplied uuid array is the new full
 * order: it must contain every existing uuid exactly once.
 *
 * Three exit branches:
 *
 *   1. Module index out of range → `{ error }`, no mutations.
 *   2. The supplied order doesn't permute the existing uuids — length
 *      mismatch, duplicates, unknown uuids, or missing uuids →
 *      `{ error }`, no mutations.
 *   3. Success → `{ message, order }` plus the persisted mutation,
 *      tagged `module:M:caseList:searchInput:reorder`.
 */

import { z } from "zod";
import { asUuid, type BlueprintDoc, type Uuid } from "@/lib/domain";
import { reorderSearchInputsMutation } from "../../blueprintHelpers";
import type { ToolExecutionContext } from "../../toolExecutionContext";
import { applyToDoc, type MutatingToolResult } from "../common";
import { uuidInputSchema } from "./shared";

export const reorderSearchInputsInputSchema = z.object({
	moduleIndex: z
		.number()
		.describe("0-based module index whose case list search inputs to reorder"),
	searchInputUuids: z
		.array(uuidInputSchema)
		.describe(
			"The new full search-input order, given as the array of search-input uuids in their target order. Must contain every existing search-input uuid exactly once — no duplicates, no unknown uuids, no missing uuids. Look at getModule's projection for the current uuid set.",
		),
});

export type ReorderSearchInputsInput = z.infer<
	typeof reorderSearchInputsInputSchema
>;

export interface ReorderSearchInputsSuccess {
	message: string;
	order: Uuid[];
}

export type ReorderSearchInputsResult =
	| ReorderSearchInputsSuccess
	| { error: string };

export const reorderSearchInputsTool = {
	description:
		"Reorder the search inputs on a module's case list. Pass the new full order as the array of existing search-input uuids — must contain every existing uuid exactly once.",
	inputSchema: reorderSearchInputsInputSchema,
	async execute(
		input: ReorderSearchInputsInput,
		ctx: ToolExecutionContext,
		doc: BlueprintDoc,
	): Promise<MutatingToolResult<ReorderSearchInputsResult>> {
		const { moduleIndex, searchInputUuids: rawSearchInputUuids } = input;
		const searchInputUuids = rawSearchInputUuids.map(asUuid);
		try {
			const moduleUuid = doc.moduleOrder[moduleIndex];
			if (!moduleUuid) return moduleNotFoundResult(doc, moduleIndex);
			const mod = doc.modules[moduleUuid];
			if (!mod) return moduleNotFoundResult(doc, moduleIndex);

			const result = reorderSearchInputsMutation(
				doc,
				moduleUuid,
				searchInputUuids,
			);
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
				`module:${moduleIndex}:caseList:searchInput:reorder`,
			);

			return {
				kind: "mutate" as const,
				mutations: result.mutations,
				newDoc,
				result: {
					message: `Reordered ${searchInputUuids.length} search input${searchInputUuids.length === 1 ? "" : "s"} on module "${mod.name}".`,
					order: [...searchInputUuids],
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
): MutatingToolResult<ReorderSearchInputsResult> {
	return {
		kind: "mutate" as const,
		mutations: [],
		newDoc: doc,
		result: {
			error: `Tried to reorder search inputs on module ${moduleIndex}. Found no module at that index. Look at getModule's projection for the available module indices.`,
		},
	};
}
