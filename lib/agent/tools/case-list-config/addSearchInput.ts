/**
 * SA tool: `addSearchInput` — add one search input to a module's case
 * list.
 *
 * Atomic op — appends ONE entry to `caseListConfig.searchInputs` and
 * preserves every other slot. The tool mints a fresh `uuid` for the new
 * entry and surfaces it in both the success message and a structured
 * `result.uuid` field so the SA can target subsequent edits without a
 * separate read.
 *
 * Two exit branches:
 *
 *   1. Module index out of range → `{ error }`, no mutations.
 *   2. Success → `{ message, uuid }` plus the persisted mutation,
 *      tagged `module:M:caseList:searchInput:add`.
 */

import { z } from "zod";
import type { BlueprintDoc, Uuid } from "@/lib/domain";
import { addSearchInputMutation } from "../../blueprintHelpers";
import type { ToolExecutionContext } from "../../toolExecutionContext";
import { applyToDoc, type MutatingToolResult } from "../common";
import {
	newUuid,
	searchInputDefInputSchema,
	stampSearchInputUuid,
} from "./shared";

export const addSearchInputInputSchema = z.object({
	moduleIndex: z
		.number()
		.describe("0-based module index whose case list to add a search input to"),
	searchInput: searchInputDefInputSchema.describe(
		"The search input to append. Pick a kind (`simple` for property/mode/via inputs or `advanced` for a free-form predicate) and supply the kind's required fields plus any optional `default` slot. The tool mints the input's uuid; do not supply one.",
	),
});

export type AddSearchInputInput = z.infer<typeof addSearchInputInputSchema>;

export interface AddSearchInputSuccess {
	message: string;
	uuid: Uuid;
}

export type AddSearchInputResult = AddSearchInputSuccess | { error: string };

export const addSearchInputTool = {
	description:
		"Add one search input to a module's case list. The tool mints a fresh uuid and returns it; use that uuid on subsequent updateSearchInput / removeSearchInput / reorderSearchInputs calls. Simple inputs target a property + mode; advanced inputs carry a free-form predicate.",
	inputSchema: addSearchInputInputSchema,
	async execute(
		input: AddSearchInputInput,
		ctx: ToolExecutionContext,
		doc: BlueprintDoc,
	): Promise<MutatingToolResult<AddSearchInputResult>> {
		const { moduleIndex, searchInput } = input;
		try {
			const moduleUuid = doc.moduleOrder[moduleIndex];
			if (!moduleUuid) return moduleNotFoundResult(doc, moduleIndex);
			const mod = doc.modules[moduleUuid];
			if (!mod) return moduleNotFoundResult(doc, moduleIndex);

			const uuid = newUuid();
			const stamped = stampSearchInputUuid(searchInput, uuid);
			const result = addSearchInputMutation(doc, moduleUuid, stamped);
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
				`module:${moduleIndex}:caseList:searchInput:add`,
			);

			const finalCount =
				newDoc.modules[moduleUuid]?.caseListConfig?.searchInputs.length ?? 0;
			return {
				kind: "mutate" as const,
				mutations: result.mutations,
				newDoc,
				result: {
					message: `Added ${searchInput.kind} search input "${searchInput.label}" (uuid ${uuid}) at index ${finalCount - 1} on module "${mod.name}".`,
					uuid,
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
): MutatingToolResult<AddSearchInputResult> {
	return {
		kind: "mutate" as const,
		mutations: [],
		newDoc: doc,
		result: {
			error: `Tried to add a search input on module ${moduleIndex}. Found no module at that index. Look at getModule's projection for the available module indices.`,
		},
	};
}
