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
 * A `connect` block carries the exact canonical expression AST
 * (`shared/connectInput.ts::buildConnectConfig`, same as `updateForm`).
 * A reference to a field landing in this same call uses that field's
 * predeclared final UUID, so no name/path resolution occurs here. The
 * merged block then runs through
 * `enforceConnectIds` (the agent-path source guard, same as
 * `updateForm` / `createModule`): an omitted connect id is autofilled
 * with a valid, unique, name-derived id (stored on the doc from then
 * on), and an explicit invalid or duplicate id fails the call — the
 * schema's "leave the id unset and Nova fills it in" promise holds on
 * this tool too.
 *
 * Both the SA chat factory and the MCP adapter call this through the
 * shared `ToolExecutionContext` interface. Exit branches:
 *
 *   1. Parent module UUID address does not resolve → `{ error }`, no mutations.
 *   2. Identifier guard rejection (any field id illegal / reserved /
 *      over-long / batch-conflicting) → `{ error }` naming EVERY failing
 *      item, nothing persisted.
 *   3. An explicit connect id is invalid/duplicate → `{ error }`, no
 *      mutations.
 *   4. Commit-gate rejection (the batch would introduce a validator
 *      finding) → `{ error }` listing each finding, nothing persisted.
 *   5. Success → human-readable summary with the new form's positional
 *      index + field count, tagged under `module:M` so the event log
 *      groups this creation with the rest of that module's activity.
 */

import { z } from "zod";
import { orderedFormUuids } from "@/lib/doc/fieldWalk";
import type {
	BlueprintDoc,
	ConnectConfig,
	FormType,
	PostSubmitDestination,
} from "@/lib/domain";
import {
	asUuid,
	FORM_TYPES,
	findAuthoredBlueprintIdentity,
	USER_FACING_DESTINATIONS,
	uuidSchema,
} from "@/lib/domain";
import { addFormMutations } from "../blueprintHelpers";
import {
	closeConditionInputSchema,
	connectFormConfigSchema,
} from "../planningSchemas";
import type { ToolExecutionContext } from "../toolExecutionContext";
import { addFieldsItemSchema } from "../toolSchemas";
import {
	guardedMutate,
	type MutatingToolResult,
	toToolErrorResult,
} from "./common";
import { collectConnectIds, enforceConnectIds } from "./shared/connectIds";
import { buildConnectConfig } from "./shared/connectInput";
import {
	moduleAddressSchema,
	resolveModuleAddress,
} from "./shared/entityAddresses";
import {
	assembleFieldMutations,
	describeRejectedFieldIds,
	resolveCloseCondition,
} from "./shared/fieldAssembly";
import type {
	MutationSuccess,
	ToolCallSummary,
} from "./shared/toolCallSummary";

export const createFormInputSchema = moduleAddressSchema
	.extend({
		formUuid: uuidSchema
			.optional()
			.describe(
				"Stable UUID for the new form. Omit when nothing in this call references the form.",
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
				"The form's fields, in order — a form is created together with its content in one call (a registration form must include a case_name writer). Same per-field shape as addFields; use parentUuid on an item to nest it under a predeclared group/repeat created earlier in this list.",
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
				'Where the user goes after submitting. Defaults to "previous" for followup/close, "app_home" for registration/survey. Only set to override.',
			),
		close_condition: closeConditionInputSchema
			.nullable()
			.optional()
			.describe(
				"Close forms only — close the case only when the UUID-addressed field matches (the field may be predeclared in this same call). null for an unconditional close.",
			),
		connect: connectFormConfigSchema
			.nullable()
			.optional()
			.describe(
				"Per-form Connect config — a block opts the form INTO Connect, and a participating form lands with its block in this call. Pass null on a form that shouldn't participate (a Connect app just needs at least one participating form), and always on standard apps.",
			),
	})
	.strict();

export type CreateFormInput = z.infer<typeof createFormInputSchema>;

/** Human-readable success string or an error record. */
export type CreateFormResult =
	| (MutationSuccess & {
			formUuid: string;
			fields: Array<{ uuid: string; id: string }>;
	  })
	| { error: string };

export const createFormTool = {
	description:
		"Add a new form to a module together with its fields, in one call. The form and its content land as one unit — pass every field the form needs (use addFields later for additions).",
	inputSchema: createFormInputSchema,
	async execute(
		input: CreateFormInput,
		ctx: ToolExecutionContext,
		doc: BlueprintDoc,
	): Promise<MutatingToolResult<CreateFormResult>> {
		const {
			moduleUuid: rawModuleUuid,
			formUuid: requestedFormUuid,
			name,
			type,
			fields,
			purpose,
			post_submit,
			close_condition,
			connect,
		} = input;
		try {
			const address = resolveModuleAddress(doc, {
				moduleUuid: rawModuleUuid,
			});
			if (!address.ok) {
				return {
					kind: "mutate" as const,
					mutations: [],
					newDoc: doc,
					result: { error: address.error },
				};
			}
			const { moduleUuid, module } = address;

			// Mint the form's uuid here so the field assembly can target it —
			// the form only exists once the addForm mutation applies, but the
			// assembly's sibling scans correctly read an absent `fieldOrder`
			// entry as "no existing siblings".
			const formUuid = requestedFormUuid ?? asUuid(crypto.randomUUID());
			if (findAuthoredBlueprintIdentity(doc, formUuid) !== undefined) {
				return {
					kind: "mutate" as const,
					mutations: [],
					newDoc: doc,
					result: {
						error: `formUuid ${formUuid} already belongs to an authored entity in this app.`,
					},
				};
			}

			// Assemble the fields first so their predeclared UUIDs are present
			// in the same atomic mutation batch as any connect references.
			const assembly = assembleFieldMutations({
				doc,
				formUuid,
				items: fields,
				occupiedUuids: new Set([formUuid]),
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

			// The connect block already carries canonical AST. A same-call
			// field reference names the field's predeclared UUID. Then force
			// connect ids correct at the source: autofill an omitted id
			// (valid + unique, derived from the module/form name), reject an
			// explicit invalid or duplicate id by failing the call (writes
			// nothing).
			// No exclusion is passed to the collector — the form this call
			// creates doesn't exist in the doc yet, so every stored id is a
			// potential conflict.
			let enforcedConnect: ConnectConfig | undefined;
			if (connect) {
				const enforced = enforceConnectIds(
					buildConnectConfig(connect, undefined),
					module.name,
					name,
					collectConnectIds(doc),
				);
				if (!enforced.ok) {
					return {
						kind: "mutate" as const,
						mutations: [],
						newDoc: doc,
						result: { error: enforced.error },
					};
				}
				enforcedConnect = enforced.config;
			}

			if (
				close_condition &&
				!assembly.created.some(
					(field) => field.uuid === close_condition.fieldUuid,
				)
			) {
				return {
					kind: "mutate" as const,
					mutations: [],
					newDoc: doc,
					result: {
						error: `Close-condition fieldUuid ${close_condition.fieldUuid} is not a field created in form "${name}".`,
					},
				};
			}
			const closeCondition = resolveCloseCondition(close_condition);
			const formMutations = addFormMutations(doc, moduleUuid, {
				uuid: formUuid,
				name,
				type: type as FormType,
				...(purpose != null && { purpose }),
				...(post_submit && {
					postSubmit: post_submit as PostSubmitDestination,
				}),
				...(closeCondition && { closeCondition }),
				...(enforcedConnect && { connect: enforcedConnect }),
			});

			// Tag under the parent module — the event log groups this
			// creation event with the rest of that module's activity so the
			// lifecycle UI renders "forms added to Patient module" as one
			// chapter rather than interleaved events per form index.
			const mutations = [...formMutations, ...assembly.mutations];
			const commit = await guardedMutate(
				ctx,
				doc,
				mutations,
				`module:${moduleUuid}`,
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
			const forms = orderedFormUuids(newDoc, moduleUuid);
			// Count the fields, not the batch: the assembly prepends the
			// declaration chokepoint's catalog mutations for undeclared types.
			const fieldCount = assembly.mutations.filter(
				(m) => m.kind === "addField",
			).length;
			const skippedNote =
				assembly.skipped.length > 0
					? ` Skipped ${assembly.skipped.length} field(s): ${assembly.skipped
							.map((s) => `${s.id} (${s.reason})`)
							.join("; ")}.`
					: "";
			return {
				kind: "mutate" as const,
				mutations: commit.mutations,
				newDoc,
				result: {
					message: `Successfully created form "${name}" (${type}, UUID ${formUuid}) with ${fieldCount} field${fieldCount === 1 ? "" : "s"} in module "${mod?.name ?? moduleUuid}". Module now has ${forms.length} form${forms.length === 1 ? "" : "s"}.${skippedNote}`,
					formUuid,
					fields: assembly.created,
					summary: {
						location: mod?.name,
						subject: name,
					} satisfies ToolCallSummary,
				},
			};
		} catch (err) {
			return toToolErrorResult(err, doc);
		}
	},
};
