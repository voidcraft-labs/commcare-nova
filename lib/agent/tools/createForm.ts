/**
 * SA tool: `createForm` — add a new form to a module, together with its
 * fields, in one gated batch.
 *
 * Creation is ATOMIC: a form lands with the content that makes it sound
 * and complete (the validity gate evaluates the whole batch — on a
 * complete app, an empty form would introduce EMPTY_FORM and a
 * registration form without a `case_name` writer would introduce
 * NO_CASE_NAME_FIELD, both rejected at this call with the validator's
 * own repair guidance, all satisfiable by adjusting THIS call's
 * `fields`). The field items ride the same shared per-kind schema
 * `addFields` uses, through the same assembly pipeline
 * (`shared/fieldAssembly.ts`), so groups + nested children compose
 * identically on both tools.
 *
 * Both the SA chat factory and the MCP adapter call this through the
 * shared `ToolExecutionContext` interface. Exit branches:
 *
 *   1. Parent module index out of range → `{ error }`, no mutations.
 *   2. Identifier guard rejection (any field id illegal / reserved /
 *      over-long / batch-conflicting) → `{ error }` naming EVERY failing
 *      item, nothing persisted.
 *   3. Commit-gate rejection (the batch would introduce a validator
 *      finding) → `{ error }` listing each finding, nothing persisted.
 *   4. Success → human-readable summary with the new form's positional
 *      index + field count, tagged under `module:M` so the event log
 *      groups this creation with the rest of that module's activity.
 */

import { z } from "zod";
import type {
	BlueprintDoc,
	ConnectConfig,
	FormType,
	PostSubmitDestination,
} from "@/lib/domain";
import { asUuid, FORM_TYPES, USER_FACING_DESTINATIONS } from "@/lib/domain";
import { addFormMutations } from "../blueprintHelpers";
import type { FlatField } from "../contentProcessing";
import { connectFormConfigSchema } from "../scaffoldSchemas";
import type { ToolExecutionContext } from "../toolExecutionContext";
import { addFieldsItemSchema } from "../toolSchemas";
import { guardedMutate, type MutatingToolResult } from "./common";
import {
	assembleFieldMutations,
	describeRejectedFieldIds,
} from "./shared/fieldAssembly";
import type {
	MutationSuccess,
	ToolCallSummary,
} from "./shared/toolCallSummary";

export const createFormInputSchema = z
	.object({
		moduleIndex: z.number().describe("0-based module index"),
		name: z.string().describe("Form display name"),
		type: z
			.enum(FORM_TYPES)
			.describe(
				'"registration" creates a new case. "followup" updates an existing case. "close" loads and closes an existing case. "survey" is standalone.',
			),
		fields: z
			.array(addFieldsItemSchema)
			.min(1)
			.describe(
				"The form's fields, in order — a form is created together with its content in one call (a registration form must include a case_name writer). Same per-field shape as addFields; use parentId on an item to nest it under a group/repeat created earlier in this list.",
			),
		post_submit: z
			.enum(USER_FACING_DESTINATIONS)
			.optional()
			.describe(
				'Where the user goes after submitting. Defaults to "previous" for followup/close, "app_home" for registration/survey. Only set to override.',
			),
		connect: connectFormConfigSchema
			.optional()
			.describe(
				"Per-form Connect config — REQUIRED when the app's connect_type is learn or deliver (a Connect form lands with its block in this call); omit on standard apps.",
			),
	})
	.strict();

export type CreateFormInput = z.infer<typeof createFormInputSchema>;

/** Human-readable success string or an error record. */
export type CreateFormResult = MutationSuccess | { error: string };

export const createFormTool = {
	description:
		"Add a new form to a module together with its fields, in one call. The form and its content land as one unit — pass every field the form needs (use addFields later for additions).",
	inputSchema: createFormInputSchema,
	async execute(
		input: CreateFormInput,
		ctx: ToolExecutionContext,
		doc: BlueprintDoc,
	): Promise<MutatingToolResult<CreateFormResult>> {
		const { moduleIndex, name, type, fields, post_submit, connect } = input;
		try {
			const moduleUuid = doc.moduleOrder[moduleIndex];
			if (!moduleUuid) {
				return {
					kind: "mutate" as const,
					mutations: [],
					newDoc: doc,
					result: { error: `Module ${moduleIndex} not found` },
				};
			}

			// Mint the form's uuid here so the field assembly can target it —
			// the form only exists once the addForm mutation applies, but the
			// assembly's sibling scans correctly read an absent `fieldOrder`
			// entry as "no existing siblings".
			const formUuid = asUuid(crypto.randomUUID());
			const formMutations = addFormMutations(doc, moduleUuid, {
				uuid: formUuid,
				name,
				type: type as FormType,
				...(post_submit && {
					postSubmit: post_submit as PostSubmitDestination,
				}),
				...(connect && { connect: connect as ConnectConfig }),
			});

			// Per-kind union arms are validated structural subsets of the wide
			// `FlatField` the pipeline operates on — same bridge cast as
			// `addFields`.
			const assembly = assembleFieldMutations({
				doc,
				formUuid,
				items: fields as FlatField[],
			});
			if (!assembly.ok) {
				return {
					kind: "mutate" as const,
					mutations: [],
					newDoc: doc,
					result: {
						error: describeRejectedFieldIds(
							name,
							fields.length,
							assembly.rejected,
						),
					},
				};
			}
			if (assembly.mutations.length === 0) {
				// Every supplied field failed assembly — landing the form would
				// land it EMPTY, which is exactly the dead shape atomic creation
				// exists to prevent. Name each skip so the corrected re-issue
				// carries usable fields.
				const reasons = assembly.skipped
					.map((s) => `- "${s.id}": ${s.reason}`)
					.join("\n");
				return {
					kind: "mutate" as const,
					mutations: [],
					newDoc: doc,
					result: {
						error: `"${name}" wasn't created — none of its ${fields.length} field(s) could be assembled, so the form would have no content:\n${reasons}\nFix the listed field(s) and re-issue the call.`,
					},
				};
			}

			// Tag under the parent module — the event log groups this
			// creation event with the rest of that module's activity so the
			// lifecycle UI renders "forms added to Patient module" as one
			// chapter rather than interleaved events per form index.
			const mutations = [...formMutations, ...assembly.mutations];
			const commit = await guardedMutate(
				ctx,
				doc,
				mutations,
				`module:${moduleIndex}`,
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

			const mod = newDoc.modules[moduleUuid];
			const forms = newDoc.formOrder[moduleUuid] ?? [];
			const newFormIndex = forms.length - 1;
			const fieldCount = assembly.mutations.length;
			const skippedNote =
				assembly.skipped.length > 0
					? ` Skipped ${assembly.skipped.length} field(s): ${assembly.skipped
							.map((s) => `${s.id} (${s.reason})`)
							.join("; ")}.`
					: "";
			return {
				kind: "mutate" as const,
				mutations,
				newDoc,
				result: {
					message: `Successfully created form "${name}" (${type}) with ${fieldCount} field${fieldCount === 1 ? "" : "s"} in module "${mod?.name ?? moduleIndex}" at index m${moduleIndex}-f${newFormIndex}. Module now has ${forms.length} form${forms.length === 1 ? "" : "s"}.${skippedNote}`,
					summary: {
						location: mod?.name,
						subject: name,
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
