/**
 * SA tool: `reorderCaseListColumns` — reorder the columns array on a
 * module's case list.
 *
 * Atomic op — reorders `caseListConfig.columns` in place and preserves
 * every other slot. The supplied uuid array is the new full order: it
 * must contain every existing uuid exactly once. Reorder is the only
 * operation that needs to know the full uuid set, so the input shape
 * mirrors that contract directly.
 *
 * Three exit branches:
 *
 *   1. Module index out of range → `{ error }`, no mutations.
 *   2. The supplied order doesn't permute the existing uuids — length
 *      mismatch, duplicates, unknown uuids, or missing uuids → `{ error }`,
 *      no mutations.
 *   3. Success → `{ message, order }` plus the persisted mutation,
 *      tagged `module:M:caseList:column:reorder`.
 */

import { z } from "zod";
import { asUuid, type BlueprintDoc, type Uuid } from "@/lib/domain";
import { reorderColumnsMutation } from "../../blueprintHelpers";
import type { ToolExecutionContext } from "../../toolExecutionContext";
import { applyToDoc, type MutatingToolResult } from "../common";
import { moduleNotFoundResult, uuidInputSchema } from "./shared";

export const reorderCaseListColumnsInputSchema = z
	.object({
		moduleIndex: z
			.number()
			.describe("0-based module index whose case list columns to reorder"),
		columnUuids: z
			.array(uuidInputSchema)
			.describe(
				"The new full column order, given as the array of column uuids in their target order. Must contain every existing column uuid exactly once — no duplicates, no unknown uuids, no missing uuids. Look at getModule's projection for the current uuid set.",
			),
	})
	.strict();

export type ReorderCaseListColumnsInput = z.infer<
	typeof reorderCaseListColumnsInputSchema
>;

export interface ReorderCaseListColumnsSuccess {
	message: string;
	order: Uuid[];
}

export type ReorderCaseListColumnsResult =
	| ReorderCaseListColumnsSuccess
	| { error: string };

export const reorderCaseListColumnsTool = {
	description:
		"Reorder the case list columns on a module. Pass the new full order as the array of existing column uuids — must contain every existing uuid exactly once.",
	inputSchema: reorderCaseListColumnsInputSchema,
	async execute(
		input: ReorderCaseListColumnsInput,
		ctx: ToolExecutionContext,
		doc: BlueprintDoc,
	): Promise<MutatingToolResult<ReorderCaseListColumnsResult>> {
		const { moduleIndex, columnUuids: rawColumnUuids } = input;
		const columnUuids = rawColumnUuids.map(asUuid);
		try {
			const moduleUuid = doc.moduleOrder[moduleIndex];
			if (!moduleUuid)
				return moduleNotFoundResult<ReorderCaseListColumnsSuccess>(
					doc,
					moduleIndex,
					"reorder case list columns",
				);
			const mod = doc.modules[moduleUuid];
			if (!mod)
				return moduleNotFoundResult<ReorderCaseListColumnsSuccess>(
					doc,
					moduleIndex,
					"reorder case list columns",
				);

			const result = reorderColumnsMutation(mod, columnUuids);
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
				`module:${moduleIndex}:caseList:column:reorder`,
			);

			return {
				kind: "mutate" as const,
				mutations: result.mutations,
				newDoc,
				result: {
					message: `Reordered ${columnUuids.length} case list column${columnUuids.length === 1 ? "" : "s"} on module "${mod.name}".`,
					order: [...columnUuids],
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
