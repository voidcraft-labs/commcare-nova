/**
 * SA tool: `removeForm` — delete a form (with its field subtree) from
 * a module.
 *
 * Both the SA chat factory and the MCP adapter call this through the
 * shared `ToolExecutionContext` interface. The reducer cascades
 * deletion to the form's fields — the full subtree is dropped atomically.
 *
 * The tool tolerates a missing form index: instead of returning an
 * error (which would poison the SA's follow-up logic), it returns a
 * clear "does not exist, no change" success message. The SA sees the
 * target-already-gone state explicitly and keeps moving rather than
 * reasoning as though the removal just happened. This mirrors the
 * `removeModule` contract.
 *
 * Two exit branches:
 *
 *   - Missing index → no mutations, "does not exist, no change" message.
 *   - Success → human-readable "Successfully removed" summary tagged
 *     `form:M-F`.
 */

import { z } from "zod";
import type { Mutation } from "@/lib/doc/types";
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

			// Missing index → return a clear "no change" summary. A
			// "Successfully removed" string on a missing target would
			// poison the SA's follow-up reasoning — it would assume the
			// form was just deleted and e.g. skip a subsequent recreate
			// step. Reporting the state truthfully (target not present,
			// no mutation applied) keeps the SA aligned with reality.
			if (!formUuid) {
				const moduleUuid = doc.moduleOrder[moduleIndex];
				const mod = moduleUuid ? doc.modules[moduleUuid] : undefined;
				const remainingForms = (moduleUuid && doc.formOrder[moduleUuid]) ?? [];
				return {
					kind: "mutate" as const,
					mutations: [],
					newDoc: doc,
					result: `Form m${moduleIndex}-f${formIndex} does not exist — no change. Module "${mod?.name ?? `module ${moduleIndex}`}" has ${remainingForms.length} form${remainingForms.length === 1 ? "" : "s"}.`,
				};
			}

			// Snapshot the pre-mutation display name so the summary can
			// reference the real form even after cascade deletion removes
			// it from `forms`.
			const removedName = doc.forms[formUuid]?.name ?? `form ${formIndex}`;

			const mutations: Mutation[] = removeFormMutations(doc, formUuid);
			const newDoc = applyToDoc(doc, mutations);
			await ctx.recordMutations(
				mutations,
				newDoc,
				`form:${moduleIndex}-${formIndex}`,
			);

			const moduleUuid = newDoc.moduleOrder[moduleIndex];
			const mod = moduleUuid ? newDoc.modules[moduleUuid] : undefined;
			const remainingForms = (moduleUuid && newDoc.formOrder[moduleUuid]) ?? [];
			return {
				kind: "mutate" as const,
				mutations,
				newDoc,
				result: `Successfully removed form "${removedName}" from module "${mod?.name ?? `module ${moduleIndex}`}". Module now has ${remainingForms.length} form${remainingForms.length === 1 ? "" : "s"}.`,
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
