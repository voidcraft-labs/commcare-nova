/**
 * SA tool: `createModule` — add a new module to the app, together with
 * everything that makes it sound and complete, in one gated batch.
 *
 * Creation is ATOMIC. A case-managing module is only valid WITH its
 * forms (NO_FORMS_OR_CASE_LIST is a soundness rule — it rejects in every
 * phase) and, on a complete app, WITH its case-list columns
 * (MISSING_CASE_LIST_COLUMNS is completeness — the ratchet rejects
 * introducing it). So the tool accepts `forms` (each with its `fields`)
 * and `case_list_columns`, and emits one batch: addModule + addForm × N
 * + addField × M + the case-list config — the gate evaluates the whole
 * thing as one candidate, and a rejection's findings are all satisfiable
 * by adjusting THIS call.
 *
 * Follow-up case-list refinement (sort, filter, search inputs) still
 * goes through the case-list-config tools once the module exists; this
 * tool's `case_list_columns` exists so the module can BE BORN complete.
 *
 * Both the SA chat factory and the MCP adapter call this through the
 * shared `ToolExecutionContext` interface. Exit branches:
 *
 *   1. Identifier guard rejection in any form's fields → `{ error }`
 *      naming every failing item, nothing persisted.
 *   2. Commit-gate rejection → `{ error }` listing each finding,
 *      nothing persisted.
 *   3. Unexpected runtime error → `{ error }`, no mutations.
 *   4. Success → a human-readable `message` (+ a UI `summary`) carrying
 *      the new module's index + structure counts, stage `module:create`.
 */

import { z } from "zod";
import type { BlueprintDoc, ConnectConfig } from "@/lib/domain";
import { asUuid, FORM_TYPES, USER_FACING_DESTINATIONS } from "@/lib/domain";
import { addFormMutations, addModuleMutations } from "../blueprintHelpers";
import type { FlatField } from "../contentProcessing";
import { connectFormConfigSchema } from "../scaffoldSchemas";
import type { ToolExecutionContext } from "../toolExecutionContext";
import { addFieldsItemSchema } from "../toolSchemas";
import {
	columnInputSchema,
	newUuid,
	stampColumnUuid,
} from "./case-list-config/shared";
import { guardedMutate, type MutatingToolResult } from "./common";
import {
	assembleFieldMutations,
	describeRejectedFieldIds,
} from "./shared/fieldAssembly";
import type {
	MutationSuccess,
	ToolCallSummary,
} from "./shared/toolCallSummary";

const createModuleFormSchema = z
	.object({
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
				"The form's fields, in order (same per-field shape as addFields). A registration form must include a case_name writer.",
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

export const createModuleInputSchema = z
	.object({
		name: z.string().describe("Module display name"),
		case_type: z
			.string()
			.optional()
			.describe(
				"Case type (required if the module has registration/followup/close forms)",
			),
		forms: z
			.array(createModuleFormSchema)
			.optional()
			.describe(
				"The module's forms, each with its fields — a case-managing module must land WITH its forms in this call (a case-typed module with no forms is rejected). Omit only for a case_list_only module.",
			),
		case_list_columns: z
			.array(columnInputSchema)
			.optional()
			.describe(
				"Case-list columns for a case-managing module, in display order — required alongside `case_type` so the case list can render rows (usually start with the name property). Refine later (sort, filter, search inputs) via the case-list-config tools.",
			),
		case_list_only: z
			.boolean()
			.optional()
			.describe(
				"True for case-list-only modules with no forms. Use for child case types that need to be viewable but have no follow-up workflow.",
			),
	})
	.strict();

export type CreateModuleInput = z.infer<typeof createModuleInputSchema>;

/** Human-readable success string or an error record. */
export type CreateModuleResult = MutationSuccess | { error: string };

export const createModuleTool = {
	description:
		"Add a new module to the app, together with its forms (each with fields) and case-list columns, in one call — a case-managing module lands complete or not at all. Refine the case list afterward (sort, filter, search inputs) via the case-list-config tools.",
	inputSchema: createModuleInputSchema,
	async execute(
		input: CreateModuleInput,
		ctx: ToolExecutionContext,
		doc: BlueprintDoc,
	): Promise<MutatingToolResult<CreateModuleResult>> {
		const { name, case_type, forms, case_list_columns, case_list_only } = input;
		try {
			// Stage tag `module:create` — a positional index isn't available
			// yet because the new module's slot only exists after the
			// mutations apply. Downstream consumers that need the index read
			// it from the post-mutation `moduleOrder`.
			const moduleUuid = asUuid(crypto.randomUUID());
			const columns = (case_list_columns ?? []).map((c) =>
				stampColumnUuid(c, newUuid()),
			);
			const mutations = addModuleMutations(doc, {
				uuid: moduleUuid,
				name,
				...(case_type && { caseType: case_type }),
				...(case_list_only && { caseListOnly: case_list_only }),
				...(columns.length > 0 && {
					caseListConfig: { columns, searchInputs: [] },
				}),
			});

			let fieldCount = 0;
			const skipped: Array<{ id: string; reason: string }> = [];
			for (const formInput of forms ?? []) {
				const formUuid = asUuid(crypto.randomUUID());
				mutations.push(
					...addFormMutations(
						doc,
						moduleUuid,
						{
							uuid: formUuid,
							name: formInput.name,
							type: formInput.type,
							...(formInput.post_submit && {
								postSubmit: formInput.post_submit,
							}),
							...(formInput.connect && {
								connect: formInput.connect as ConnectConfig,
							}),
						},
						// The module is created by THIS batch — skip the
						// doc-existence guard that would otherwise reject it.
						{ moduleAddedInBatch: true },
					),
				);
				const assembly = assembleFieldMutations({
					doc,
					formUuid,
					// Per-kind union arms are validated structural subsets of the
					// wide `FlatField` the pipeline operates on — same bridge cast
					// as `addFields`.
					items: formInput.fields as FlatField[],
				});
				if (!assembly.ok) {
					return {
						kind: "mutate" as const,
						mutations: [],
						newDoc: doc,
						result: {
							error: describeRejectedFieldIds(
								formInput.name,
								formInput.fields.length,
								assembly.rejected,
							),
						},
					};
				}
				if (assembly.mutations.length === 0) {
					// Every supplied field failed assembly — landing the form
					// would land it EMPTY, the dead shape atomic creation exists
					// to prevent. Name each skip so the corrected re-issue
					// carries usable fields.
					const reasons = assembly.skipped
						.map((s) => `- "${s.id}": ${s.reason}`)
						.join("\n");
					return {
						kind: "mutate" as const,
						mutations: [],
						newDoc: doc,
						result: {
							error: `Module "${name}" wasn't created — none of form "${formInput.name}"'s ${formInput.fields.length} field(s) could be assembled, so the form would have no content:\n${reasons}\nFix the listed field(s) and re-issue the call.`,
						},
					};
				}
				mutations.push(...assembly.mutations);
				fieldCount += assembly.mutations.length;
				skipped.push(...assembly.skipped);
			}

			const commit = await guardedMutate(ctx, doc, mutations, "module:create");
			if (!commit.ok) {
				return {
					kind: "mutate" as const,
					mutations: [],
					newDoc: doc,
					result: { error: commit.error },
				};
			}
			const newDoc = commit.newDoc;

			const newModIndex = newDoc.moduleOrder.length - 1;
			const formCount = (forms ?? []).length;
			const structureNote =
				formCount > 0
					? ` with ${formCount} form${formCount === 1 ? "" : "s"} (${fieldCount} field${fieldCount === 1 ? "" : "s"})${columns.length > 0 ? ` and ${columns.length} case-list column${columns.length === 1 ? "" : "s"}` : ""}`
					: columns.length > 0
						? ` with ${columns.length} case-list column${columns.length === 1 ? "" : "s"}`
						: "";
			const skippedNote =
				skipped.length > 0
					? ` Skipped ${skipped.length} field(s): ${skipped
							.map((s) => `${s.id} (${s.reason})`)
							.join("; ")}.`
					: "";
			return {
				kind: "mutate" as const,
				mutations,
				newDoc,
				result: {
					message: `Successfully created module "${name}" at index ${newModIndex}${case_type ? ` (case type: ${case_type})` : ""}${structureNote}. App now has ${newDoc.moduleOrder.length} module${newDoc.moduleOrder.length === 1 ? "" : "s"}.${skippedNote}`,
					summary: { subject: name } satisfies ToolCallSummary,
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
