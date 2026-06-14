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
import { guardedMutate, type MutatingToolResult } from "./common";
import type {
	MutationSuccess,
	ToolCallSummary,
} from "./shared/toolCallSummary";

export const removeFieldInputSchema = z
	.object({
		moduleIndex: z.number().describe("0-based module index"),
		formIndex: z.number().describe("0-based form index"),
		fieldId: z.string().describe("Field id to remove"),
	})
	.strict();

export type RemoveFieldInput = z.infer<typeof removeFieldInputSchema>;

/** Human-readable success string or an error record. */
export type RemoveFieldResult = MutationSuccess | { error: string };

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
					kind: "mutate" as const,
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
			// Snapshot the human label off the pre-mutation field for the
			// transcript subject (label-less kinds fall back to the id) — mirrors
			// the friendly subject addField / editField surface.
			const removedLabel =
				"label" in resolved.field ? resolved.field.label : "";
			const beforeCount = countFieldsUnder(doc, formUuid);
			const mutations = removeFieldMutations(doc, resolved.field.uuid);
			const commit = await guardedMutate(
				ctx,
				doc,
				mutations,
				`form:${moduleIndex}-${formIndex}`,
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
			const formName = newDoc.forms[formUuid]?.name ?? "";
			const afterCount = countFieldsUnder(newDoc, formUuid);
			return {
				kind: "mutate" as const,
				mutations,
				newDoc,
				result: {
					message: `Successfully removed field "${fieldId}" from "${formName}". Fields: ${beforeCount} → ${afterCount}.`,
					summary: {
						location: formName,
						subject: removedLabel || fieldId,
					} satisfies ToolCallSummary,
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
