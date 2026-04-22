/**
 * SA tool: `removeForm` — delete a form (with its field subtree) from
 * a module.
 *
 * Both the SA chat factory and the MCP adapter call this through the
 * shared `ToolExecutionContext` interface. The reducer cascades
 * deletion to the form's fields — the full subtree is dropped atomically.
 *
 * The tool tolerates a missing form index: instead of returning an
 * error, it falls through with an informational success message so the
 * SA can re-query without crashing the tool loop when it targets an
 * index that's already gone. This mirrors the `removeModule` contract.
 *
 * One exit branch reached by every call:
 *
 *   - Success (or silent no-op on a missing index) → human-readable
 *     summary; stage tagged `form:M-F` whenever mutations actually
 *     apply.
 */

import { z } from "zod";
import type { BlueprintDoc } from "@/lib/domain";
import { removeFormMutations, resolveFormUuid } from "../blueprintHelpers";
import type { ToolExecutionContext } from "../toolExecutionContext";
import { applyToDoc, type MutatingToolResult } from "./common";

export const removeFormInputSchema = z.object({
	moduleIndex: z.number().describe("0-based module index"),
	formIndex: z.number().describe("0-based form index"),
});

export type RemoveFormInput = z.infer<typeof removeFormInputSchema>;

/** Human-readable success string or an error record. */
export type RemoveFormResult = string | { error: string };

export const removeFormTool = {
	name: "removeForm" as const,
	description: "Remove a form from a module.",
	inputSchema: removeFormInputSchema,
	async execute(
		input: RemoveFormInput,
		ctx: ToolExecutionContext,
		doc: BlueprintDoc,
	): Promise<MutatingToolResult<RemoveFormResult>> {
		const { moduleIndex, formIndex } = input;
		try {
			const formUuid = resolveFormUuid(doc, moduleIndex, formIndex);
			// Snapshot the pre-mutation display name so we can surface it
			// in the summary string even if the form existed only briefly.
			const removedName = formUuid
				? (doc.forms[formUuid]?.name ?? `form ${formIndex}`)
				: `form ${formIndex}`;

			// Only emit + apply when the form actually exists; a missing
			// form resolves to `undefined` and we fall through with an
			// informational success message rather than erroring. This
			// lenient contract matches `removeModule` — mutating tools that
			// see "target already gone" shouldn't hard-fail the SA's loop.
			let mutations: Parameters<typeof ctx.recordMutations>[0] = [];
			let newDoc = doc;
			if (formUuid) {
				mutations = removeFormMutations(doc, formUuid);
				newDoc = applyToDoc(doc, mutations);
				await ctx.recordMutations(
					mutations,
					newDoc,
					`form:${moduleIndex}-${formIndex}`,
				);
			}

			const moduleUuid = newDoc.moduleOrder[moduleIndex];
			const mod = moduleUuid ? newDoc.modules[moduleUuid] : undefined;
			const remainingForms = (moduleUuid && newDoc.formOrder[moduleUuid]) ?? [];
			return {
				mutations,
				newDoc,
				result: `Successfully removed form "${removedName}" from module "${mod?.name ?? `module ${moduleIndex}`}". Module now has ${remainingForms.length} form${remainingForms.length === 1 ? "" : "s"}.`,
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
