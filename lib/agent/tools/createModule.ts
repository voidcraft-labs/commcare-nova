/**
 * SA tool: `createModule` — add a new module to the app, together with
 * everything that makes it sound and complete, in one gated batch.
 *
 * Creation is ATOMIC. EVERY module is only valid WITH its forms
 * (NO_FORMS_OR_CASE_LIST — a formless menu is a hard CommCare build
 * error, the sole exception being a `case_list_only` viewer), and a
 * case-managing one additionally WITH its case-list columns
 * (MISSING_CASE_LIST_COLUMNS — completeness, gated like everything
 * else). So the tool accepts `forms` (each with its `fields`) and
 * `case_list_columns`, and emits one batch: addModule + addForm × N +
 * addField × M + the case-list config — the gate evaluates the whole
 * thing as one candidate, and a rejection's findings are all
 * satisfiable by adjusting THIS call.
 *
 * The module's CASE TYPE references the app's case-type catalog by
 * NAME — the record itself lands earlier, via `generateSchema` (the
 * data-model tool), so the model is stated once and the field assembly's
 * catalog defaulting (`applyDefaults`) seeds intrinsic type, canonical label,
 * and choice catalog. Form-context hint, requiredness, and validation remain
 * explicit on each field. An unrecorded `case_type` is rejected with the
 * generateSchema pointer.
 *
 * Follow-up case-list refinement (sort, filter, search inputs) still
 * goes through the case-list-config tools once the module exists; this
 * tool's `case_list_columns` exists so the module can BE BORN complete.
 *
 * New forms are auxiliary on a Connect app. After their final UUIDs exist,
 * `configureConnect` can replace the complete participant set atomically;
 * module creation cannot become a second owner of participation.
 *
 * Both the SA chat factory and the MCP adapter call this through the
 * shared `ToolInvocationContext` interface. Exit branches:
 *
 *   1. A `case_type` with no record in the app's catalog → `{ error }`
 *      pointing at generateSchema, no mutations.
 *   2. Identifier guard rejection in any form's fields → `{ error }`
 *      naming every failing item, nothing persisted.
 *   3. Commit-gate rejection → `{ error }` listing each finding,
 *      nothing persisted.
 *   4. Unexpected runtime error → `{ error }`, no mutations.
 *   5. Success → a human-readable `message` (+ a UI `summary`) carrying
 *      the new module's index + structure counts, stage `module:create`.
 */

import { z } from "zod";
import {
	asUuid,
	FORM_TYPES,
	findAuthoredBlueprintIdentity,
	POST_SUBMIT_DESTINATIONS,
	uuidSchema,
} from "@/lib/domain";
import { addFormMutations, addModuleMutations } from "../blueprintHelpers";
import { closeConditionInputSchema } from "../planningSchemas";
import { addFieldsItemSchema } from "../toolSchemas";
import type { ToolInvocationContext } from "../workspace/types";
import {
	columnInputSchema,
	newUuid,
	stampColumnUuid,
} from "./case-list-config/shared";
import {
	guardedMutate,
	type MutatingToolResult,
	toToolErrorResult,
} from "./common";
import {
	assembleFieldMutations,
	type CreatedFieldIdentity,
	describeRejectedFields,
	resolveCloseCondition,
} from "./shared/fieldAssembly";
import type {
	MutationSuccess,
	ToolCallSummary,
} from "./shared/toolCallSummary";

const createModuleFormSchema = z
	.object({
		formUuid: uuidSchema
			.optional()
			.describe(
				"Stable UUID for this new form. Omit when nothing in the call references it.",
			),
		name: z.string().min(1).describe("Form display name"),
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
		purpose: z
			.string()
			.min(1)
			.nullable()
			.optional()
			.describe(
				"Brief description of what this form collects and why. null when there's nothing to add.",
			),
		post_submit: z
			.enum(POST_SUBMIT_DESTINATIONS)
			.nullable()
			.optional()
			.describe(
				'Where the user goes after submitting. Defaults to "previous" for followup/close, "app_home" for registration/survey. Pass null to use the default; set a value only to override.',
			),
		close_condition: closeConditionInputSchema
			.nullable()
			.optional()
			.describe(
				"Close forms only — close the case only when the UUID-addressed field matches (the field may be predeclared in this same call). null for an unconditional close.",
			),
	})
	.strict();

export const createModuleInputSchema = z
	.object({
		moduleUuid: uuidSchema
			.optional()
			.describe(
				"Stable UUID for the new module. Omit when nothing in the call references it.",
			),
		name: z.string().min(1).describe("Module display name"),
		case_type: z
			.string()
			.min(1)
			.nullable()
			.optional()
			.describe(
				"Case type (required if the module has registration/followup/close forms) — must already be recorded on the app (generateSchema). null for a survey-only module.",
			),
		purpose: z
			.string()
			.min(1)
			.nullable()
			.optional()
			.describe(
				"Brief description of this module's role in the app. null when there's nothing to add.",
			),
		forms: z
			.array(createModuleFormSchema)
			.nullable()
			.optional()
			.describe(
				"The module's forms, each with its fields — EVERY module must land WITH at least one form in this call (a formless module is rejected: CommCare needs a form or a case list to show). null only for a case_list_only viewer module.",
			),
		case_list_columns: z
			.array(columnInputSchema)
			.nullable()
			.optional()
			.describe(
				"Case-list columns, display order — required alongside case_type (start with the name property). Refine later via the case-list-config tools. null only on a survey-only module.",
			),
		case_list_only: z
			.boolean()
			.nullable()
			.optional()
			.describe(
				"True for case-list-only modules with no forms. Use for child case types that need to be viewable but have no follow-up workflow. null otherwise.",
			),
	})
	.strict()
	.superRefine((input, ctx) => {
		if (
			input.case_type != null &&
			!input.case_list_columns?.some((column) => column.visibleInList !== false)
		) {
			ctx.addIssue({
				code: "custom",
				path: ["case_list_columns"],
				message:
					"A case-managing module must be born with at least one visible Results field in case_list_columns. Re-issue createModule with a plain case_name column. Results columns belong to the module's case-list configuration, not addFields.",
			});
		}
		if (input.case_list_only === true && input.case_type == null) {
			ctx.addIssue({
				code: "custom",
				path: ["case_type"],
				message:
					"A case-list-only module must name the case_type whose records it shows.",
			});
		}
	});

export type CreateModuleInput = z.infer<typeof createModuleInputSchema>;

/** Human-readable success string or an error record. */
export type CreateModuleResult =
	| (MutationSuccess & {
			moduleUuid: string;
			forms: Array<{
				uuid: string;
				name: string;
				fields: CreatedFieldIdentity[];
			}>;
			columns: Array<{ uuid: string }>;
	  })
	| { error: string };

export const createModuleTool = {
	description:
		"Add a new module to the app, together with its forms (each with fields) and case-list columns, in one call — a case-managing module lands complete or not at all. Refine the case list afterward (sort, filter, search inputs) via the case-list-config tools.",
	inputSchema: createModuleInputSchema,
	async execute(
		input: CreateModuleInput,
		ctx: ToolInvocationContext,
	): Promise<MutatingToolResult<CreateModuleResult>> {
		const doc = ctx.snapshot.doc;
		const {
			moduleUuid: requestedModuleUuid,
			name,
			case_type,
			purpose,
			forms,
			case_list_columns,
			case_list_only,
		} = input;
		try {
			/* The module's case type references the catalog by name — the
			 * record itself landed earlier via generateSchema (or the field
			 * assembly's declaration chokepoint, for a bare writer-declared
			 * type). A name nothing answers to is a plan gap, not a doc state
			 * to guess through. */
			if (case_type && !doc.caseTypes?.some((ct) => ct.name === case_type)) {
				return {
					kind: "mutate" as const,
					mutations: [],
					result: {
						error: `Module "${name}" wasn't created — the app has no data-model record for case type "${case_type}". Record it first with generateSchema (its properties, labels, and any parent link), then re-issue this call.`,
					},
				};
			}

			// Stage tag `module:create` — a positional index isn't available
			// yet because the new module's slot only exists after the
			// mutations apply. Downstream consumers that need the index read
			// it from the post-mutation `moduleOrder`.
			const moduleUuid = requestedModuleUuid ?? asUuid(crypto.randomUUID());
			if (findAuthoredBlueprintIdentity(doc, moduleUuid) !== undefined) {
				return {
					kind: "mutate" as const,
					mutations: [],
					result: {
						error: `moduleUuid ${moduleUuid} already belongs to an authored entity in this app.`,
					},
				};
			}
			// Stamp each born column with a uuid. Position is the array they sit
			// in, so writing them in order is all it takes.
			const columns = (case_list_columns ?? []).map((column) =>
				stampColumnUuid(
					column,
					column.columnUuid === undefined
						? newUuid()
						: asUuid(column.columnUuid),
				),
			);
			const mutations = [
				...addModuleMutations({
					uuid: moduleUuid,
					name,
					...(case_type && { caseType: case_type }),
					...(case_list_only && { caseListOnly: case_list_only }),
					...(purpose != null && { purpose }),
					...(columns.length > 0 && {
						caseListConfig: {
							columns,
							listColumnOrder: columns.map((column) => column.uuid),
							detailColumnOrder: columns.map((column) => column.uuid),
							searchInputs: [],
						},
					}),
				}),
			];

			let fieldCount = 0;
			const createdForms: Array<{
				uuid: string;
				name: string;
				fields: CreatedFieldIdentity[];
			}> = [];
			const callEntityUuids = new Set([
				moduleUuid,
				...columns.map((column) => column.uuid),
				...(forms ?? [])
					.map((form) => form.formUuid)
					.filter(
						(uuid): uuid is NonNullable<typeof uuid> => uuid !== undefined,
					),
			]);
			if (
				callEntityUuids.size !==
				1 +
					columns.length +
					(forms ?? []).filter((form) => form.formUuid !== undefined).length
			) {
				return {
					kind: "mutate" as const,
					mutations: [],
					result: {
						error:
							"moduleUuid, formUuid, and column UUID declarations in this call must be unique.",
					},
				};
			}
			const existingCollision = [...callEntityUuids].find(
				(uuid) => findAuthoredBlueprintIdentity(doc, uuid) !== undefined,
			);
			if (existingCollision !== undefined) {
				return {
					kind: "mutate" as const,
					mutations: [],
					result: {
						error: `UUID ${existingCollision} already belongs to an authored object in this app.`,
					},
				};
			}
			// The module + all its forms land in ONE batch. Each `addForm`
			// appends, so emitting them in order is what orders them — they no
			// longer need to derive keys off each other.
			for (const formInput of forms ?? []) {
				const formUuid = formInput.formUuid ?? asUuid(crypto.randomUUID());
				if (
					(callEntityUuids.has(formUuid) && formInput.formUuid === undefined) ||
					findAuthoredBlueprintIdentity(doc, formUuid) !== undefined
				) {
					return {
						kind: "mutate" as const,
						mutations: [],
						result: {
							error: `minted form UUID ${formUuid} collided with another identity in this call.`,
						},
					};
				}
				callEntityUuids.add(formUuid);
				// Assemble every field into the same atomic module-creation batch.
				// Catalog defaulting reads `doc.caseTypes` — the records
				// generateSchema committed ahead of this call.
				const assembly = assembleFieldMutations({
					doc,
					formUuid,
					items: formInput.fields,
					occupiedUuids: callEntityUuids,
				});
				if (!assembly.ok) {
					return {
						kind: "mutate" as const,
						mutations: [],
						result: {
							error: describeRejectedFields(
								formInput.name,
								formInput.fields.length,
								assembly.rejected,
							),
						},
					};
				}
				if (
					formInput.close_condition &&
					!assembly.created.some(
						(field) => field.uuid === formInput.close_condition?.fieldUuid,
					)
				) {
					return {
						kind: "mutate" as const,
						mutations: [],
						result: {
							error: `Module "${name}" wasn't created — close-condition fieldUuid ${formInput.close_condition.fieldUuid} is not a field created in form "${formInput.name}".`,
						},
					};
				}
				const closeCondition = resolveCloseCondition(formInput.close_condition);
				mutations.push(
					...addFormMutations(
						doc,
						moduleUuid,
						{
							uuid: formUuid,
							name: formInput.name,
							type: formInput.type,
							...(formInput.purpose != null && {
								purpose: formInput.purpose,
							}),
							...(formInput.post_submit && {
								postSubmit: formInput.post_submit,
							}),
							...(closeCondition && { closeCondition }),
						},
						// The module is created by THIS batch — skip the
						// doc-existence guard that would otherwise reject it.
						{ moduleAddedInBatch: true },
					),
				);
				mutations.push(...assembly.mutations);
				createdForms.push({
					uuid: formUuid,
					name: formInput.name,
					fields: assembly.created,
				});
				for (const field of assembly.created) {
					callEntityUuids.add(field.uuid);
					for (const option of field.options) {
						callEntityUuids.add(option.uuid);
					}
				}
				// Count the fields, not the batch: the assembly prepends the
				// declaration chokepoint's catalog mutations for undeclared
				// types.
				fieldCount += assembly.mutations.filter(
					(m) => m.kind === "addField",
				).length;
			}

			const commit = await guardedMutate(ctx, mutations, "module:create");
			if (!commit.ok) {
				return {
					kind: "mutate" as const,
					mutations: [],
					result: { error: commit.error },
				};
			}
			const newDoc = commit.newDoc;

			const formCount = (forms ?? []).length;
			const structureNote =
				formCount > 0
					? ` with ${formCount} form${formCount === 1 ? "" : "s"} (${fieldCount} field${fieldCount === 1 ? "" : "s"})${columns.length > 0 ? ` and ${columns.length} case-list column${columns.length === 1 ? "" : "s"}` : ""}`
					: columns.length > 0
						? ` with ${columns.length} case-list column${columns.length === 1 ? "" : "s"}`
						: "";
			return {
				kind: "mutate" as const,
				mutations: commit.mutations,
				result: {
					message: `Successfully created module "${name}" (UUID ${moduleUuid})${case_type ? ` (case type: ${case_type})` : ""}${structureNote}. App now has ${newDoc.moduleOrder.length} module${newDoc.moduleOrder.length === 1 ? "" : "s"}.`,
					moduleUuid,
					forms: createdForms,
					columns: columns.map((column) => ({ uuid: column.uuid })),
					summary: { subject: name } satisfies ToolCallSummary,
				},
			};
		} catch (err) {
			return toToolErrorResult(err);
		}
	},
};
