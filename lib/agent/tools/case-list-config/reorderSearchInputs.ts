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
import {
	reorderSearchInputsMutation,
	resolveModuleUuid,
} from "../../blueprintHelpers";
import type { ToolExecutionContext } from "../../toolExecutionContext";
import {
	guardedMutate,
	type MutatingToolResult,
	toToolErrorResult,
} from "../common";
import type { ToolCallSummary } from "../shared/toolCallSummary";
import { moduleNotFoundResult, uuidInputSchema } from "./shared";

export const reorderSearchInputsInputSchema = z
	.object({
		moduleIndex: z
			.number()
			.describe(
				"0-based module index whose case list search inputs to reorder",
			),
		searchInputUuids: z
			.array(uuidInputSchema)
			.describe(
				"The new full search-input order, given as the array of search-input uuids in their target order. Must contain every existing search-input uuid exactly once — no duplicates, no unknown uuids, no missing uuids. Look at getModule's projection for the current uuid set.",
			),
	})
	.strict();

export type ReorderSearchInputsInput = z.infer<
	typeof reorderSearchInputsInputSchema
>;

export interface ReorderSearchInputsSuccess {
	message: string;
	order: Uuid[];
	summary: ToolCallSummary;
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
			const moduleUuid = resolveModuleUuid(doc, moduleIndex);
			if (!moduleUuid)
				return moduleNotFoundResult<ReorderSearchInputsSuccess>(
					doc,
					moduleIndex,
					"reorder search inputs",
				);
			const mod = doc.modules[moduleUuid];
			if (!mod)
				return moduleNotFoundResult<ReorderSearchInputsSuccess>(
					doc,
					moduleIndex,
					"reorder search inputs",
				);

			const result = reorderSearchInputsMutation(mod, searchInputUuids);
			if ("error" in result) {
				return {
					kind: "mutate" as const,
					mutations: [],
					newDoc: doc,
					result: { error: result.error },
				};
			}

			const commit = await guardedMutate(
				ctx,
				doc,
				result.mutations,
				`module:${moduleIndex}:caseList:searchInput:reorder`,
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

			return {
				kind: "mutate" as const,
				mutations: result.mutations,
				newDoc,
				result: {
					message: `Reordered ${searchInputUuids.length} search input${searchInputUuids.length === 1 ? "" : "s"} on module "${mod.name}".`,
					order: [...searchInputUuids],
					summary: { location: mod.name, count: searchInputUuids.length },
				},
			};
		} catch (err) {
			return toToolErrorResult(err, doc);
		}
	},
};
