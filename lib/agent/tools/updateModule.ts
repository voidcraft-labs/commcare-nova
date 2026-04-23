/**
 * SA tool: `updateModule` — patch module-level metadata.
 *
 * Covers the three module-scoped edits the SA exposes: display name,
 * case list columns, and case detail columns. Both the SA chat factory
 * and the MCP adapter call this through the shared
 * `ToolExecutionContext` interface. The `case_detail_columns` key
 * supports `null` as "clear" — matches the store's
 * `updateModuleMutations` convention for nullable columns.
 *
 * Three exit branches:
 *
 *   1. Module index out of range → `{ error }`, no mutations.
 *   2. Module disappeared between resolution and patch (shouldn't
 *      happen under normal flow) → `{ error }`.
 *   3. Success → human-readable summary listing the changed keys,
 *      tagged `module:M`.
 */

import { z } from "zod";
import type { BlueprintDoc } from "@/lib/domain";
import { updateModuleMutations } from "../blueprintHelpers";
import type { ToolExecutionContext } from "../toolExecutionContext";
import { applyToDoc, type MutatingToolResult } from "./common";

export const updateModuleInputSchema = z.object({
	moduleIndex: z.number().describe("0-based module index"),
	name: z.string().optional().describe("New module name"),
	case_list_columns: z
		.array(
			z.object({
				field: z.string().describe("Case property name"),
				header: z.string().describe("Column header text"),
			}),
		)
		.optional()
		.describe("New case list columns"),
	case_detail_columns: z
		.array(
			z.object({
				field: z.string().describe("Case property name"),
				header: z.string().describe("Display label for this detail field"),
			}),
		)
		.nullable()
		.optional()
		.describe("Columns for case detail view. null to remove."),
});

export type UpdateModuleInput = z.infer<typeof updateModuleInputSchema>;

/** Human-readable success string or an error record. */
export type UpdateModuleResult = string | { error: string };

export const updateModuleTool = {
	description:
		"Update module metadata: name, case list columns, or case detail columns.",
	inputSchema: updateModuleInputSchema,
	async execute(
		input: UpdateModuleInput,
		ctx: ToolExecutionContext,
		doc: BlueprintDoc,
	): Promise<MutatingToolResult<UpdateModuleResult>> {
		const { moduleIndex, name, case_list_columns, case_detail_columns } = input;
		try {
			const moduleUuid = doc.moduleOrder[moduleIndex];
			if (!moduleUuid) {
				return {
					mutations: [],
					newDoc: doc,
					result: { error: `Module ${moduleIndex} not found` },
				};
			}

			// Build the helper patch lazily — every omitted key stays
			// out so the reducer's `undefined`-means-leave-alone semantics
			// hold. `null` on `case_detail_columns` is a value, not an
			// absence: it maps to the helper's "clear" signal.
			const patch: Parameters<typeof updateModuleMutations>[2] = {};
			if (name !== undefined) patch.name = name;
			if (case_list_columns !== undefined)
				patch.caseListColumns = case_list_columns;
			if (case_detail_columns !== undefined) {
				patch.caseDetailColumns =
					case_detail_columns === null ? null : case_detail_columns;
			}

			const mutations = updateModuleMutations(doc, moduleUuid, patch);
			const newDoc = applyToDoc(doc, mutations);
			await ctx.recordMutations(mutations, newDoc, `module:${moduleIndex}`);

			// Read back from the post-mutation doc so the summary reflects the
			// values the SA can expect on a follow-up read.
			const mod = newDoc.modules[moduleUuid];
			if (!mod) {
				return {
					mutations,
					newDoc,
					result: { error: `Module ${moduleIndex} not found after update` },
				};
			}
			const changes: string[] = [];
			if (name !== undefined) changes.push(`name → "${mod.name}"`);
			if (case_list_columns !== undefined)
				changes.push(`case list columns (${mod.caseListColumns?.length ?? 0})`);
			if (case_detail_columns !== undefined)
				changes.push(
					case_detail_columns === null
						? "case detail columns removed"
						: `case detail columns (${mod.caseDetailColumns?.length ?? 0})`,
				);
			return {
				mutations,
				newDoc,
				result: `Successfully updated module "${mod.name}" (index ${moduleIndex}). Changed: ${changes.join(", ")}.`,
			};
		} catch (err) {
			return {
				mutations: [],
				newDoc: doc,
				result: { error: err instanceof Error ? err.message : String(err) },
			};
		}
	},
};
