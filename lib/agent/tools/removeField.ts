/**
 * SA tool: `removeField` — delete a field (with its subtree) from a form.
 *
 * Thin wrapper over `removeFieldMutations`. Both the SA chat factory
 * and the MCP adapter call this through the shared
 * `ToolExecutionContext` interface. The reducer cascades deletion to
 * the field's children — container kinds drop their entire subtree.
 *
 * Two exit branches:
 *
 *   1. Field not found at the given triple → `{ error }`, no mutations.
 *   2. Success → human-readable summary showing before/after field
 *      counts, tagged `form:M-F`.
 */

import { z } from "zod";
import { countFieldsUnder } from "@/lib/doc/fieldWalk";
import type { BlueprintDoc } from "@/lib/domain";
import { removeFieldMutations, resolveFieldByIndex } from "../blueprintHelpers";
import type { ToolExecutionContext } from "../toolExecutionContext";
import { applyToDoc, type MutatingToolResult } from "./common";

export const removeFieldInputSchema = z.object({
	moduleIndex: z.number().describe("0-based module index"),
	formIndex: z.number().describe("0-based form index"),
	fieldId: z.string().describe("Field id to remove"),
});

export type RemoveFieldInput = z.infer<typeof removeFieldInputSchema>;

/** Human-readable success string or an error record. */
export type RemoveFieldResult = string | { error: string };

export const removeFieldTool = {
	description: "Remove a field from a form.",
	inputSchema: removeFieldInputSchema,
	async execute(
		input: RemoveFieldInput,
		ctx: ToolExecutionContext,
		doc: BlueprintDoc,
	): Promise<MutatingToolResult<RemoveFieldResult>> {
		const { moduleIndex, formIndex, fieldId } = input;
		try {
			const resolved = resolveFieldByIndex(
				doc,
				moduleIndex,
				formIndex,
				fieldId,
			);
			if (!resolved) {
				return {
					mutations: [],
					newDoc: doc,
					result: {
						error: `Field "${fieldId}" not found in m${moduleIndex}-f${formIndex}`,
					},
				};
			}
			// Snapshot the pre-mutation count so the result can read "N → N-1".
			// Counting against the post-mutation doc gives the new count for
			// the "after" side — both values flow into the same summary string.
			const formUuid = resolved.formUuid;
			const beforeCount = countFieldsUnder(doc, formUuid);
			const mutations = removeFieldMutations(doc, resolved.field.uuid);
			const newDoc = applyToDoc(doc, mutations);
			await ctx.recordMutations(
				mutations,
				newDoc,
				`form:${moduleIndex}-${formIndex}`,
			);
			const formName = newDoc.forms[formUuid]?.name ?? "";
			const afterCount = countFieldsUnder(newDoc, formUuid);
			return {
				mutations,
				newDoc,
				result: `Successfully removed field "${fieldId}" from "${formName}". Fields: ${beforeCount} → ${afterCount}.`,
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
