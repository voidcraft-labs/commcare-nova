/**
 * SA tool: `addCaseListColumn` — add one column to a module's case
 * list.
 *
 * Atomic op — appends ONE column to `caseListConfig.columns` and
 * preserves every other slot of the config. The tool mints a fresh
 * `uuid` for the new column and surfaces it in both the success
 * message and a structured `result.uuid` field so the SA can target
 * subsequent edits (sort, visibility toggles, removal) without a
 * separate read.
 *
 * Both the SA chat factory and the MCP adapter call this through the
 * shared `ToolExecutionContext` interface. Two exit branches:
 *
 *   1. Module index out of range → `{ error }`, no mutations.
 *   2. Success → `{ message, uuid }` plus the persisted mutation,
 *      tagged `module:M:caseList:column:add`.
 */

import { z } from "zod";
import type { BlueprintDoc, Uuid } from "@/lib/domain";
import { addColumnMutation } from "../../blueprintHelpers";
import type { ToolExecutionContext } from "../../toolExecutionContext";
import { applyToDoc, type MutatingToolResult } from "../common";
import { columnInputSchema, newUuid, stampColumnUuid } from "./shared";

export const addCaseListColumnInputSchema = z.object({
	moduleIndex: z
		.number()
		.describe("0-based module index whose case list to add a column to"),
	column: columnInputSchema.describe(
		"The column to append. Pick a kind (`plain` / `date` / `phone` / `id-mapping` / `interval` / `calculated`) and supply the kind's required fields plus any optional `sort`, `visibleInList`, `visibleInDetail` slots. The tool mints the column's uuid; do not supply one. Calculated columns carry an `expression` instead of a `field` — the expression is the source.",
	),
});

export type AddCaseListColumnInput = z.infer<
	typeof addCaseListColumnInputSchema
>;

/**
 * Success result — the new column's uuid surfaced both as a structured
 * field and in the human-readable message so the SA can reference it on
 * a subsequent atomic op without re-reading the module.
 */
export interface AddCaseListColumnSuccess {
	message: string;
	uuid: Uuid;
}

export type AddCaseListColumnResult =
	| AddCaseListColumnSuccess
	| { error: string };

export const addCaseListColumnTool = {
	description:
		"Add one column to a module's case list. The tool mints a fresh uuid for the column and returns it; use that uuid on subsequent updateCaseListColumn / removeCaseListColumn / reorderCaseListColumns calls. Calculated columns carry an expression instead of a field.",
	inputSchema: addCaseListColumnInputSchema,
	async execute(
		input: AddCaseListColumnInput,
		ctx: ToolExecutionContext,
		doc: BlueprintDoc,
	): Promise<MutatingToolResult<AddCaseListColumnResult>> {
		const { moduleIndex, column } = input;
		try {
			const moduleUuid = doc.moduleOrder[moduleIndex];
			if (!moduleUuid) return moduleNotFoundResult(doc, moduleIndex);
			const mod = doc.modules[moduleUuid];
			if (!mod) return moduleNotFoundResult(doc, moduleIndex);

			const uuid = newUuid();
			const stamped = stampColumnUuid(column, uuid);
			const result = addColumnMutation(mod, stamped);
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
				`module:${moduleIndex}:caseList:column:add`,
			);

			const finalCount =
				newDoc.modules[moduleUuid]?.caseListConfig?.columns.length ?? 0;
			return {
				kind: "mutate" as const,
				mutations: result.mutations,
				newDoc,
				result: {
					message: `Added ${column.kind} column "${column.header}" (uuid ${uuid}) at index ${finalCount - 1} on module "${mod.name}".`,
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
): MutatingToolResult<AddCaseListColumnResult> {
	return {
		kind: "mutate" as const,
		mutations: [],
		newDoc: doc,
		result: {
			error: `Tried to add a case list column on module ${moduleIndex}. Found no module at that index. Look at getModule's projection for the available module indices.`,
		},
	};
}
