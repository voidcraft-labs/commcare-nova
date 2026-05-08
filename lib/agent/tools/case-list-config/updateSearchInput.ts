/**
 * SA tool: `updateSearchInput` — replace one search input on a module's
 * case list, keyed by `searchInputUuid`.
 *
 * Atomic op — replaces ONE entry in `caseListConfig.searchInputs` and
 * preserves every other slot. The replacement carries the same uuid
 * (the tool stamps the existing uuid back onto the supplied shape) so
 * the input's identity survives the edit.
 *
 * The replacement is a full search-input body. Partial-patch shapes
 * don't fit the discriminated-union shape cleanly — switching between
 * `simple` and `advanced` requires a different field set, so a whole-
 * body replacement is the right shape regardless.
 *
 * Three exit branches:
 *
 *   1. Module index out of range → `{ error }`, no mutations.
 *   2. Search-input uuid not present → `{ error }`, no mutations.
 *   3. Success → `{ message, uuid }` plus the persisted mutation,
 *      tagged `module:M:caseList:searchInput:update`.
 */

import { z } from "zod";
import { asUuid, type BlueprintDoc, type Uuid } from "@/lib/domain";
import { updateSearchInputMutation } from "../../blueprintHelpers";
import type { ToolExecutionContext } from "../../toolExecutionContext";
import { applyToDoc, type MutatingToolResult } from "../common";
import {
	moduleNotFoundResult,
	searchInputDefInputSchema,
	stampSearchInputUuid,
	uuidInputSchema,
} from "./shared";

export const updateSearchInputInputSchema = z.object({
	moduleIndex: z
		.number()
		.describe("0-based module index whose case list search input to update"),
	searchInputUuid: uuidInputSchema.describe(
		"Uuid of the existing search input to replace. Look at getModule's projection or run searchBlueprint to surface the current uuids.",
	),
	searchInput: searchInputDefInputSchema.describe(
		"Replacement search-input body — pick a kind (`simple` or `advanced`) and supply the kind's required fields plus any optional `default` slot. The input's uuid carries through from the existing entry; do not supply one. Switching kinds across this call (`simple` ↔ `advanced`) is permitted; the new shape replaces the old.",
	),
});

export type UpdateSearchInputInput = z.infer<
	typeof updateSearchInputInputSchema
>;

export interface UpdateSearchInputSuccess {
	message: string;
	uuid: Uuid;
}

export type UpdateSearchInputResult =
	| UpdateSearchInputSuccess
	| { error: string };

export const updateSearchInputTool = {
	description:
		"Replace one search input on a module's case list, keyed by searchInputUuid. The replacement is a full search-input body; switching between kind:simple and kind:advanced is permitted. The existing uuid is preserved.",
	inputSchema: updateSearchInputInputSchema,
	async execute(
		input: UpdateSearchInputInput,
		ctx: ToolExecutionContext,
		doc: BlueprintDoc,
	): Promise<MutatingToolResult<UpdateSearchInputResult>> {
		const {
			moduleIndex,
			searchInputUuid: rawSearchInputUuid,
			searchInput,
		} = input;
		const searchInputUuid = asUuid(rawSearchInputUuid);
		try {
			const moduleUuid = doc.moduleOrder[moduleIndex];
			if (!moduleUuid)
				return moduleNotFoundResult<UpdateSearchInputSuccess>(
					doc,
					moduleIndex,
					"update a search input",
				);
			const mod = doc.modules[moduleUuid];
			if (!mod)
				return moduleNotFoundResult<UpdateSearchInputSuccess>(
					doc,
					moduleIndex,
					"update a search input",
				);

			const replacement = stampSearchInputUuid(searchInput, searchInputUuid);
			const result = updateSearchInputMutation(
				mod,
				searchInputUuid,
				replacement,
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
				`module:${moduleIndex}:caseList:searchInput:update`,
			);

			return {
				kind: "mutate" as const,
				mutations: result.mutations,
				newDoc,
				result: {
					message: `Updated search input ${searchInputUuid} on module "${mod.name}". New kind: ${searchInput.kind}, label "${searchInput.label}".`,
					uuid: searchInputUuid,
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
