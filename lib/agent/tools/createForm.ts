/**
 * SA tool: `createForm` — add a new form to a module, together with its
 * fields, in one gated batch.
 *
 * Creation is ATOMIC: a form lands with the content that makes it sound
 * and complete (the validity gate evaluates the whole batch — on a
 * complete app, an empty form would introduce EMPTY_FORM and a
 * registration form without a `case_name` writer would introduce
 * CASE_CREATE_NAME_MISSING, both rejected at this call with the validator's
 * own repair guidance, all satisfiable by adjusting THIS call's
 * `fields`). The field items ride the same shared per-kind schema
 * `addFields` uses, through the same assembly pipeline
 * (`shared/fieldAssembly.ts`), so groups + nested children compose
 * identically on both tools.
 *
 * A new form is auxiliary on a Connect app. App-wide participation is
 * configured afterward through `configureConnect`, once the form's final UUID
 * exists; creation cannot become a second participant-set writer.
 *
 * Both the SA chat factory and the MCP adapter call this through the
 * shared `ToolInvocationContext` interface. Exit branches:
 *
 *   1. Parent module UUID address does not resolve → `{ error }`, no mutations.
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
import { orderedFormUuids } from "@/lib/doc/fieldWalk";
import { declareCaseTypeForField } from "@/lib/doc/scaffolds";
import {
	searchAnswerFields,
	searchFirstOnMutations,
} from "@/lib/doc/searchNoMatchesForm";
import type { Mutation } from "@/lib/doc/types";
import type { FormEntry, FormType, PostSubmitDestination } from "@/lib/domain";
import {
	asUuid,
	FORM_TYPES,
	findAuthoredBlueprintIdentity,
	POST_SUBMIT_DESTINATIONS,
	uuidSchema,
} from "@/lib/domain";
import { addFormMutations } from "../blueprintHelpers";
import { closeConditionInputSchema } from "../planningSchemas";
import { addFieldsItemSchema } from "../toolSchemas";
import type { ToolInvocationContext } from "../workspace/types";
import {
	guardedMutate,
	type MutatingToolResult,
	toToolErrorResult,
} from "./common";
import {
	moduleAddressSchema,
	resolveModuleAddress,
} from "./shared/entityAddresses";
import {
	assembleFieldMutations,
	type CreatedFieldIdentity,
	describeRejectedFields,
	resolveCloseCondition,
} from "./shared/fieldAssembly";
import {
	FORM_ENTRY_DESCRIPTION,
	formEntryInputSchema,
} from "./shared/formEntry";
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
			.enum(POST_SUBMIT_DESTINATIONS)
			.nullable()
			.optional()
			.describe(
				'Where the user goes after submitting. Defaults to "previous" for followup/close ("module" when the module opens on Search), "app_home" for registration/survey. Only set to override.',
			),
		close_condition: closeConditionInputSchema
			.nullable()
			.optional()
			.describe(
				"Close forms only — close the case only when the UUID-addressed field matches (the field may be predeclared in this same call). null for an unconditional close.",
			),
		entry: formEntryInputSchema
			.nullable()
			.optional()
			.describe(FORM_ENTRY_DESCRIPTION),
		carry_search_answers: z
			.boolean()
			.nullable()
			.optional()
			.describe(
				"With entry search-no-matches: append one field per Search prompt, seeded from #search/<prompt name> and saving to the prompt's property (a hidden prompt under its own name). Leave off when your fields already carry them.",
			),
	})
	.strict();

export type CreateFormInput = z.infer<typeof createFormInputSchema>;

/** Human-readable success string or an error record. */
export type CreateFormResult =
	| (MutationSuccess & {
			formUuid: string;
			fields: CreatedFieldIdentity[];
	  })
	| { error: string };

export const createFormTool = {
	description:
		"Add a new form to a module together with its fields, in one call. The form and its content land as one unit — pass every field the form needs (use addFields later for additions).",
	inputSchema: createFormInputSchema,
	async execute(
		input: CreateFormInput,
		ctx: ToolInvocationContext,
	): Promise<MutatingToolResult<CreateFormResult>> {
		const doc = ctx.snapshot.doc;
		const {
			moduleUuid: rawModuleUuid,
			formUuid: requestedFormUuid,
			name,
			type,
			fields,
			purpose,
			post_submit,
			close_condition,
			entry,
			carry_search_answers,
		} = input;
		try {
			const address = resolveModuleAddress(doc, {
				moduleUuid: rawModuleUuid,
			});
			if (!address.ok) {
				return {
					kind: "mutate" as const,
					mutations: [],
					result: { error: address.error },
				};
			}
			const { moduleUuid } = address;

			// Mint the form's uuid here so the field assembly can target it —
			// the form only exists once the addForm mutation applies, but the
			// assembly's sibling scans correctly read an absent `fieldOrder`
			// entry as "no existing siblings".
			const formUuid = requestedFormUuid ?? asUuid(crypto.randomUUID());
			if (findAuthoredBlueprintIdentity(doc, formUuid) !== undefined) {
				return {
					kind: "mutate" as const,
					mutations: [],
					result: {
						error: `formUuid ${formUuid} already belongs to an authored entity in this app.`,
					},
				};
			}

			// Assemble every field into the same atomic form-creation batch.
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
					result: {
						error: describeRejectedFields(
							name,
							fields.length,
							assembly.rejected,
						),
					},
				};
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
					result: {
						error: `Close-condition fieldUuid ${close_condition.fieldUuid} is not a field created in form "${name}".`,
					},
				};
			}
			const closeCondition = resolveCloseCondition(close_condition);
			if (entry != null && post_submit != null) {
				return {
					kind: "mutate" as const,
					mutations: [],
					result: {
						error: `Form "${name}" cannot carry post_submit with entry search-no-matches: it always returns to Results showing the case it registered. Leave post_submit out.`,
					},
				};
			}
			if (carry_search_answers === true && entry == null) {
				return {
					kind: "mutate" as const,
					mutations: [],
					result: {
						error: `carry_search_answers needs entry { kind: "search-no-matches" }: only that form can read the search answers.`,
					},
				};
			}
			const formEntry: FormEntry | undefined =
				entry == null
					? undefined
					: {
							kind: entry.kind,
							...(entry.label != null && { label: entry.label }),
						};
			const formMutations = addFormMutations(doc, moduleUuid, {
				uuid: formUuid,
				name,
				type: type as FormType,
				...(purpose != null && { purpose }),
				...(post_submit && {
					postSubmit: post_submit as PostSubmitDestination,
				}),
				...(closeCondition && { closeCondition }),
				...(formEntry && { entry: formEntry }),
			});
			const carried: Mutation[] = [];
			if (carry_search_answers === true) {
				const occupied = new Set(assembly.created.map((field) => field.id));
				for (const field of searchAnswerFields(doc, moduleUuid, occupied)) {
					carried.push(...declareCaseTypeForField(doc, field));
					carried.push({ kind: "addField", parentUuid: formUuid, field });
				}
			}

			// Tag under the parent module — the event log groups this
			// creation event with the rest of that module's activity so the
			// lifecycle UI renders "forms added to Patient module" as one
			// chapter rather than interleaved events per form index.
			const mutations = [
				...(formEntry ? searchFirstOnMutations(doc, moduleUuid) : []),
				...formMutations,
				...assembly.mutations,
				...carried,
			];
			const commit = await guardedMutate(
				ctx,
				mutations,
				`module:${moduleUuid}`,
			);
			if (!commit.ok) {
				return {
					kind: "mutate" as const,
					mutations: [],
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
			return {
				kind: "mutate" as const,
				mutations: commit.mutations,
				result: {
					message: `Successfully created form "${name}" (${type}, UUID ${formUuid}) with ${fieldCount} field${fieldCount === 1 ? "" : "s"} in module "${mod?.name ?? moduleUuid}". Module now has ${forms.length} form${forms.length === 1 ? "" : "s"}.`,
					formUuid,
					fields: assembly.created,
					summary: {
						location: mod?.name,
						subject: name,
					} satisfies ToolCallSummary,
				},
			};
		} catch (err) {
			return toToolErrorResult(err);
		}
	},
};
