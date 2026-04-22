/**
 * SA tool: `createModule` — add a new module to the app.
 *
 * Minimal wrapper over `addModuleMutations`. The new module's
 * positional index isn't known until the mutation lands — the tool tags
 * its batch `module:create` rather than `module:M`, then reads back the
 * post-mutation `moduleOrder` length to compute the index for the
 * success message.
 *
 * Both the SA chat factory and the MCP adapter call this through the
 * shared `ToolExecutionContext` interface. Two exit branches:
 *
 *   1. Unexpected runtime error → `{ error }`, no mutations.
 *   2. Success → human-readable summary string carrying the new
 *      module's index + optional case_type, stage `module:create`.
 */

import { z } from "zod";
import type { BlueprintDoc } from "@/lib/domain";
import { addModuleMutations } from "../blueprintHelpers";
import type { ToolExecutionContext } from "../toolExecutionContext";
import { applyToDoc, type MutatingToolResult } from "./common";

export const createModuleInputSchema = z.object({
	name: z.string().describe("Module display name"),
	case_type: z
		.string()
		.optional()
		.describe(
			"Case type (required if module will have registration/followup forms)",
		),
	case_list_only: z
		.boolean()
		.optional()
		.describe(
			"True for case-list-only modules with no forms. Use for child case types that need to be viewable but have no follow-up workflow.",
		),
	case_list_columns: z
		.array(
			z.object({
				field: z.string().describe("Case property name"),
				header: z.string().describe("Column header text"),
			}),
		)
		.optional()
		.describe("Case list columns"),
});

export type CreateModuleInput = z.infer<typeof createModuleInputSchema>;

/** Human-readable success string or an error record. */
export type CreateModuleResult = string | { error: string };

export const createModuleTool = {
	name: "createModule" as const,
	description: "Add a new module to the app.",
	inputSchema: createModuleInputSchema,
	async execute(
		input: CreateModuleInput,
		ctx: ToolExecutionContext,
		doc: BlueprintDoc,
	): Promise<MutatingToolResult<CreateModuleResult>> {
		const { name, case_type, case_list_only, case_list_columns } = input;
		try {
			// Stage tag `module:create` — a positional index isn't available
			// yet because the new module's slot only exists after the
			// mutations apply. Downstream consumers that need the index read
			// it from the post-mutation `moduleOrder`.
			const mutations = addModuleMutations(doc, {
				name,
				...(case_type && { caseType: case_type }),
				...(case_list_only && { caseListOnly: case_list_only }),
				...(case_list_columns && { caseListColumns: case_list_columns }),
			});
			const newDoc = applyToDoc(doc, mutations);
			await ctx.recordMutations(mutations, newDoc, "module:create");

			const newModIndex = newDoc.moduleOrder.length - 1;
			return {
				mutations,
				newDoc,
				result: `Successfully created module "${name}" at index ${newModIndex}${case_type ? ` (case type: ${case_type})` : ""}. App now has ${newDoc.moduleOrder.length} module${newDoc.moduleOrder.length === 1 ? "" : "s"}.`,
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
