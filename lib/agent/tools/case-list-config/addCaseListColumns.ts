/**
 * SA tool: `addCaseListColumns` — add one or more columns to a module's
 * case list in a single call.
 *
 * Atomic op — appends the columns to `caseListConfig.columns` (in order)
 * and preserves every other slot of the config. The tool mints a fresh
 * `uuid` for each new column and surfaces them in both the success message
 * and a structured `result.uuids` field so the SA can target subsequent
 * edits (sort, visibility toggles, removal) without a separate read.
 *
 * There is no singular `addCaseListColumn` — one column is just a length-1
 * `columns` array, so the plural tool covers both cases with one entry on
 * the SA's tool surface (a case list is almost always configured with
 * several columns at once; the singular forced a call per column).
 *
 * Both the SA chat factory and the MCP adapter call this through the
 * shared `ToolExecutionContext` interface. Two exit branches:
 *
 *   1. Module index out of range → `{ error }`, no mutations.
 *   2. Success → `{ message, uuids }` plus the persisted mutation,
 *      tagged `module:M:caseList:column:add`.
 */

import { z } from "zod";
import type { BlueprintDoc, Uuid } from "@/lib/domain";
import { addColumnsMutation, resolveModuleUuid } from "../../blueprintHelpers";
import type { ToolExecutionContext } from "../../toolExecutionContext";
import { guardedMutate, type MutatingToolResult } from "../common";
import type { MutationSuccess } from "../shared/toolCallSummary";
import {
	columnInputSchema,
	moduleNotFoundResult,
	newUuid,
	stampColumnUuid,
} from "./shared";

export const addCaseListColumnsInputSchema = z
	.object({
		moduleIndex: z
			.number()
			.describe("0-based module index whose case list to add columns to"),
		columns: z
			.array(columnInputSchema)
			.min(1)
			.describe(
				"The columns to append, in order. Each: pick a kind (`plain` / `date` / `phone` / `id-mapping` / `image-map` / `interval` / `calculated`) and supply the kind's required fields plus any optional `sort`, `visibleInList`, `visibleInDetail` slots. The tool mints each column's uuid; do not supply one. Calculated columns carry an `expression` instead of a `field` — the expression is the source. An `image-map` column carries a `mapping: { value, assetId }[]` — each row maps a stored case-property value to an image asset id (use list_media_assets to find ids).",
			),
	})
	.strict();

export type AddCaseListColumnsInput = z.infer<
	typeof addCaseListColumnsInputSchema
>;

/**
 * Success result — the new columns' uuids surfaced both as a structured
 * field and in the human-readable message so the SA can reference any of
 * them on a subsequent atomic op without re-reading the module. `uuids` is
 * positionally aligned with the input `columns`.
 */
export interface AddCaseListColumnsSuccess extends MutationSuccess {
	uuids: Uuid[];
}

export type AddCaseListColumnsResult =
	| AddCaseListColumnsSuccess
	| { error: string };

export const addCaseListColumnsTool = {
	description:
		"Add one or more columns to a module's case list in a single call. Pass the columns in display order. The tool mints a fresh uuid for each column and returns them (aligned with the input order); use those uuids on subsequent updateCaseListColumn / removeCaseListColumn / reorderCaseListColumns calls. Calculated columns carry an expression instead of a field.",
	inputSchema: addCaseListColumnsInputSchema,
	async execute(
		input: AddCaseListColumnsInput,
		ctx: ToolExecutionContext,
		doc: BlueprintDoc,
	): Promise<MutatingToolResult<AddCaseListColumnsResult>> {
		const { moduleIndex, columns } = input;
		try {
			const moduleUuid = resolveModuleUuid(doc, moduleIndex);
			if (!moduleUuid)
				return moduleNotFoundResult<AddCaseListColumnsSuccess>(
					doc,
					moduleIndex,
					"add case list columns",
				);
			const mod = doc.modules[moduleUuid];
			if (!mod)
				return moduleNotFoundResult<AddCaseListColumnsSuccess>(
					doc,
					moduleIndex,
					"add case list columns",
				);

			const uuids = columns.map(() => newUuid());
			const stamped = columns.map((c, i) => stampColumnUuid(c, uuids[i]));
			// `addColumnsMutation` can't fail on a resolved module — it returns
			// `CaseListMutationOk` (no error arm), so there's no error branch here.
			const result = addColumnsMutation(mod, stamped);

			const commit = await guardedMutate(
				ctx,
				doc,
				result.mutations,
				`module:${moduleIndex}:caseList:column:add`,
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

			const headers = columns.map((c) => `"${c.header}"`).join(", ");
			return {
				kind: "mutate" as const,
				mutations: result.mutations,
				newDoc,
				result: {
					message: `Added ${columns.length} column${columns.length === 1 ? "" : "s"} to module "${mod.name}": ${headers}.`,
					uuids,
					summary: { location: mod.name, count: columns.length },
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
