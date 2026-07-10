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
 * `case_list_columns`, and emits one batch: the case-type record +
 * addModule + addForm × N + addField × M + the case-list config — the
 * gate evaluates the whole thing as one candidate, and a rejection's
 * findings are all satisfiable by adjusting THIS call.
 *
 * The CASE-TYPE RECORD rides the same batch (`case_type_record`): a
 * record declared ahead of its module would introduce
 * MISSING_CHILD_CASE_MODULE for a child type, so the record lands
 * exactly with the module that satisfies its obligations — and the
 * field assembly sees it in the same call, so catalog defaults (label,
 * options, validation) seed this module's own fields.
 *
 * Follow-up case-list refinement (sort, filter, search inputs) still
 * goes through the case-list-config tools once the module exists; this
 * tool's `case_list_columns` exists so the module can BE BORN complete.
 *
 * Each form's `connect` block crosses the text → AST parse boundary
 * (`shared/connectInput.ts::buildConnectConfig`, same as `updateForm` /
 * `createForm`) against that form's batch-aware assembly resolver — an
 * `assessment.user_score` referencing a field landing in the same form
 * resolves to an identity leaf — and then runs through
 * `enforceConnectIds` (the agent-path source guard). One app-wide id
 * set threads through every form in the call, so an omitted id
 * autofills valid + unique across the whole creation and an explicit
 * invalid or duplicate id fails the call.
 *
 * Both the SA chat factory and the MCP adapter call this through the
 * shared `ToolExecutionContext` interface. Exit branches:
 *
 *   1. A `case_type_record` that mismatches `case_type` or re-declares
 *      an existing record → `{ error }`, no mutations.
 *   2. Identifier guard rejection in any form's fields → `{ error }`
 *      naming every failing item, nothing persisted.
 *   3. An explicit connect id is invalid/duplicate → `{ error }`, no
 *      mutations.
 *   4. Commit-gate rejection → `{ error }` listing each finding,
 *      nothing persisted.
 *   5. Unexpected runtime error → `{ error }`, no mutations.
 *   6. Success → a human-readable `message` (+ a UI `summary`) carrying
 *      the new module's index + structure counts, stage `module:create`.
 */

import { z } from "zod";
import { orderedModuleUuids } from "@/lib/doc/fieldWalk";
import { sequenceOrderKeys } from "@/lib/doc/order/append";
import type { Mutation } from "@/lib/doc/types";
import type { BlueprintDoc, CaseType, ConnectConfig } from "@/lib/domain";
import { asUuid, FORM_TYPES, USER_FACING_DESTINATIONS } from "@/lib/domain";
import { addFormMutations, addModuleMutations } from "../blueprintHelpers";
import type { FlatField } from "../contentProcessing";
import {
	caseTypeRecordSchema,
	cleanCaseTypeRecord,
	connectFormConfigSchema,
} from "../planningSchemas";
import type { ToolExecutionContext } from "../toolExecutionContext";
import { addFieldsItemSchema } from "../toolSchemas";
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
import { collectConnectIds, enforceConnectIds } from "./shared/connectIds";
import { buildConnectConfig } from "./shared/connectInput";
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
			.enum(USER_FACING_DESTINATIONS)
			.nullable()
			.optional()
			.describe(
				'Where the user goes after submitting. Defaults to "previous" for followup/close, "app_home" for registration/survey. Pass null to use the default; set a value only to override.',
			),
		connect: connectFormConfigSchema
			.nullable()
			.optional()
			.describe(
				"Per-form Connect config — a block opts the form INTO Connect, and a participating form lands with its block in this call. Pass null on a form that shouldn't participate (a Connect app just needs at least one participating form), and always on standard apps.",
			),
	})
	.strict();

export const createModuleInputSchema = z
	.object({
		name: z.string().min(1).describe("Module display name"),
		case_type: z
			.string()
			.min(1)
			.nullable()
			.optional()
			.describe(
				"Case type (required if the module has registration/followup/close forms). null for a survey-only module.",
			),
		case_type_record: caseTypeRecordSchema
			.nullable()
			.optional()
			.describe(
				"The case type's record (properties, parent link) from the data-model plan — provide it when this call's case_type is NEW to the app (its name must equal case_type). A child case type's record lands with ITS module, never earlier. null when the case type already has a record (or the module has none).",
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
				"Case-list columns for a case-managing module, in display order — required alongside `case_type` so the case list can render rows (usually start with the name property). Refine later (sort, filter, search inputs) via the case-list-config tools. null only on a survey-only module.",
			),
		case_list_only: z
			.boolean()
			.nullable()
			.optional()
			.describe(
				"True for case-list-only modules with no forms. Use for child case types that need to be viewable but have no follow-up workflow. null otherwise.",
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
		const {
			name,
			case_type,
			case_type_record,
			purpose,
			forms,
			case_list_columns,
			case_list_only,
		} = input;
		try {
			/* The case-type record rides this batch. Reject the shapes that
			 * can't mean what the caller intended: a record naming a type
			 * other than the module's own, and a record for a type the app
			 * already carries (re-declaring would silently replace the
			 * existing catalog entry other forms' defaults were seeded from). */
			let assemblyDoc = doc;
			const recordMutations: Mutation[] = [];
			if (case_type_record) {
				if (!case_type || case_type_record.name !== case_type) {
					return {
						kind: "mutate" as const,
						mutations: [],
						newDoc: doc,
						result: {
							error: `Module "${name}" wasn't created — its case_type_record is named "${case_type_record.name}" but the module's case_type is ${case_type ? `"${case_type}"` : "unset"}. The record describes the module's own case type, so the two names must match.`,
						},
					};
				}
				if (doc.caseTypes?.some((ct) => ct.name === case_type_record.name)) {
					return {
						kind: "mutate" as const,
						mutations: [],
						newDoc: doc,
						result: {
							error: `Module "${name}" wasn't created — the app already has a case-type record for "${case_type_record.name}". Omit case_type_record (the existing record stays as is), or edit the existing record instead of re-declaring it.`,
						},
					};
				}
				// Collapse the record's forced-key nulls to absence BEFORE it
				// touches the catalog — a null hint/parent_type on a stored
				// CaseProperty fails the next load's Zod gate.
				const record = cleanCaseTypeRecord(case_type_record) as CaseType;
				const mergedCaseTypes = [...(doc.caseTypes ?? []), record];
				/* Granular catalog emission keyed by `(type, property)` name — a
				 * `declareCaseType` for the new type, `setCaseTypeMeta` for its
				 * ancestry, then one `addCaseProperty` per declared property — so a
				 * co-member's concurrent catalog add to a DIFFERENT type merges
				 * (a wholesale `setCaseTypes` would clobber it). */
				recordMutations.push({
					kind: "declareCaseType",
					caseType: record.name,
				});
				if (record.parent_type != null || record.relationship != null) {
					recordMutations.push({
						kind: "setCaseTypeMeta",
						caseType: record.name,
						parent_type: record.parent_type ?? null,
						relationship: record.relationship ?? null,
					});
				}
				for (const property of record.properties) {
					recordMutations.push({
						kind: "addCaseProperty",
						caseType: record.name,
						property,
					});
				}
				/* The field assembly's catalog defaulting reads
				 * `doc.caseTypes`; thread the merged catalog through so this
				 * call's own fields seed from the record landing with it. */
				assemblyDoc = { ...doc, caseTypes: mergedCaseTypes };
			}

			// Stage tag `module:create` — a positional index isn't available
			// yet because the new module's slot only exists after the
			// mutations apply. Downstream consumers that need the index read
			// it from the post-mutation `moduleOrder`.
			const moduleUuid = asUuid(crypto.randomUUID());
			// Stamp each born column with a uuid AND an ascending `order` key —
			// a member born keyless would sort ahead of (or behind) a later keyed
			// sibling until a reload's backfill, so mint the key at construction.
			const columnKeys = sequenceOrderKeys((case_list_columns ?? []).length);
			const columns = (case_list_columns ?? []).map((c, i) => ({
				...stampColumnUuid(c, newUuid()),
				order: columnKeys[i],
			}));
			const mutations = [
				...recordMutations,
				...addModuleMutations(doc, {
					uuid: moduleUuid,
					name,
					...(case_type && { caseType: case_type }),
					...(case_list_only && { caseListOnly: case_list_only }),
					...(purpose != null && { purpose }),
					...(columns.length > 0 && {
						caseListConfig: { columns, searchInputs: [] },
					}),
				}),
			];

			let fieldCount = 0;
			const skipped: Array<{ id: string; reason: string }> = [];
			// One app-wide id set threads through every form in this call:
			// `enforceConnectIds` adds each autofilled/explicit-valid id as it
			// goes, so two id-less blocks across sibling forms can't derive the
			// same slug. No exclusion — none of this call's forms exist in the
			// doc yet.
			const takenConnectIds = collectConnectIds(doc);
			// The module + all its forms land in ONE batch, so none of these
			// forms is in `doc` yet — pre-mint a sequential `order` run here
			// (they can't derive keys off each other) and hand each form its key.
			const formKeys = sequenceOrderKeys((forms ?? []).length);
			let formIdx = 0;
			for (const formInput of forms ?? []) {
				const formUuid = asUuid(crypto.randomUUID());
				// Assembled BEFORE the connect block so the block's XPath
				// slots can parse against this form's batch-aware resolver.
				const assembly = assembleFieldMutations({
					doc: assemblyDoc,
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
				// Text → AST parse boundary for the connect XPath slots
				// (against this form's batch resolver), then the id source
				// guard against the call-wide threaded set.
				let enforcedConnect: ConnectConfig | undefined;
				if (formInput.connect) {
					const enforced = enforceConnectIds(
						buildConnectConfig(
							formInput.connect,
							undefined,
							assembly.parseExpression,
						),
						name,
						formInput.name,
						takenConnectIds,
					);
					if (!enforced.ok) {
						return {
							kind: "mutate" as const,
							mutations: [],
							newDoc: doc,
							result: {
								error: `Module "${name}" wasn't created — form "${formInput.name}": ${enforced.error}`,
							},
						};
					}
					enforcedConnect = enforced.config;
				}
				mutations.push(
					...addFormMutations(
						doc,
						moduleUuid,
						{
							uuid: formUuid,
							name: formInput.name,
							type: formInput.type,
							order: formKeys[formIdx],
							...(formInput.purpose != null && {
								purpose: formInput.purpose,
							}),
							...(formInput.post_submit && {
								postSubmit: formInput.post_submit,
							}),
							...(enforcedConnect && { connect: enforcedConnect }),
						},
						// The module is created by THIS batch — skip the
						// doc-existence guard that would otherwise reject it.
						{ moduleAddedInBatch: true },
					),
				);
				mutations.push(...assembly.mutations);
				fieldCount += assembly.mutations.length;
				skipped.push(...assembly.skipped);
				formIdx += 1;
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

			// The SA addresses modules by DISPLAY index (`sort-by-(order, uuid)`),
			// so report the new module's SORTED position — not its `moduleOrder`
			// array slot, which a born order key need not land last.
			const newModIndex = orderedModuleUuids(newDoc).indexOf(moduleUuid);
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
			return toToolErrorResult(err, doc);
		}
	},
};
