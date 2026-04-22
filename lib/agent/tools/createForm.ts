/**
 * SA tool: `createForm` — add a new empty form to a module.
 *
 * Lightweight wrapper over `addFormMutations`. Forms come in with no
 * fields; the SA follows up with `addFields` (or per-field `addField`)
 * to populate them. Both the SA chat factory and the MCP adapter call
 * this through the shared `ToolExecutionContext` interface.
 *
 * Two exit branches:
 *
 *   1. Parent module index out of range → `{ error }`, no mutations.
 *   2. Success → human-readable summary showing the new form's
 *      positional index, tagged under `module:M` so the event log
 *      groups this creation with the rest of that module's activity.
 */

import { z } from "zod";
import type {
	BlueprintDoc,
	FormType,
	PostSubmitDestination,
} from "@/lib/domain";
import { FORM_TYPES, USER_FACING_DESTINATIONS } from "@/lib/domain";
import { addFormMutations } from "../blueprintHelpers";
import type { ToolExecutionContext } from "../toolExecutionContext";
import { applyToDoc, type MutatingToolResult } from "./common";

export const createFormInputSchema = z.object({
	moduleIndex: z.number().describe("0-based module index"),
	name: z.string().describe("Form display name"),
	type: z
		.enum(FORM_TYPES)
		.describe(
			'"registration" creates a new case. "followup" updates an existing case. "close" loads and closes an existing case. "survey" is standalone.',
		),
	post_submit: z
		.enum(USER_FACING_DESTINATIONS)
		.optional()
		.describe(
			'Where the user goes after submitting. Defaults to "previous" for followup/close, "app_home" for registration/survey. Only set to override.',
		),
});

export type CreateFormInput = z.infer<typeof createFormInputSchema>;

/** Human-readable success string or an error record. */
export type CreateFormResult = string | { error: string };

export const createFormTool = {
	name: "createForm" as const,
	description:
		"Add a new empty form to a module. Use addFields to populate it.",
	inputSchema: createFormInputSchema,
	async execute(
		input: CreateFormInput,
		ctx: ToolExecutionContext,
		doc: BlueprintDoc,
	): Promise<MutatingToolResult<CreateFormResult>> {
		const { moduleIndex, name, type, post_submit } = input;
		try {
			const moduleUuid = doc.moduleOrder[moduleIndex];
			if (!moduleUuid) {
				return {
					mutations: [],
					newDoc: doc,
					result: { error: `Module ${moduleIndex} not found` },
				};
			}

			// Tag under the parent module — the event log groups this
			// creation event with the rest of that module's activity so the
			// lifecycle UI renders "forms added to Patient module" as one
			// chapter rather than interleaved events per form index.
			const mutations = addFormMutations(doc, moduleUuid, {
				name,
				type: type as FormType,
				...(post_submit && {
					postSubmit: post_submit as PostSubmitDestination,
				}),
			});
			const newDoc = applyToDoc(doc, mutations);
			await ctx.recordMutations(mutations, newDoc, `module:${moduleIndex}`);

			const mod = newDoc.modules[moduleUuid];
			const forms = newDoc.formOrder[moduleUuid] ?? [];
			const newFormIndex = forms.length - 1;
			return {
				mutations,
				newDoc,
				result: `Successfully created form "${name}" (${type}) in module "${mod?.name ?? moduleIndex}" at index m${moduleIndex}-f${newFormIndex}. Module now has ${forms.length} form${forms.length === 1 ? "" : "s"}.`,
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
