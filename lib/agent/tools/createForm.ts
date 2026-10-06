/** Create an empty form in the private candidate. Questions are authored through addFields. */
import { z } from "zod";
import { searchFirstOnMutations } from "@/lib/doc/searchNoMatchesForm";
import type { FormEntry, FormType, PostSubmitDestination } from "@/lib/domain";
import {
	asUuid,
	FORM_TYPES,
	findAuthoredBlueprintIdentity,
	POST_SUBMIT_DESTINATIONS,
	uuidSchema,
} from "@/lib/domain";
import { formNavigation } from "@/lib/preview/engine/navigationProjection";
import { addFormMutations } from "../blueprintHelpers";
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
				'Where the user goes after submitting. "previous" returns to the preceding selection or task shown by the resolved navigation result. Defaults to "previous" for followup/close ("module" when the module opens on Search), "app_home" for registration/survey. Only set to override. With entry search-no-matches, omission returns to Results and explicit app_home returns home; multiple-selection modules require app_home.',
			),
		entry: formEntryInputSchema
			.nullable()
			.optional()
			.describe(FORM_ENTRY_DESCRIPTION),
	})
	.strict();

export type CreateFormInput = z.infer<typeof createFormInputSchema>;

/** Human-readable success string or an error record. */
export type CreateFormResult =
	| (MutationSuccess & {
			formUuid: string;
			navigation: ReturnType<typeof formNavigation>;
	  })
	| { error: string };

export const createFormTool = {
	description:
		"Create a form. Add its questions separately, then configure answer-dependent naming or closing rules.",
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
			purpose,
			post_submit,
			entry,
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

			if (entry != null && post_submit != null && post_submit !== "app_home") {
				return {
					kind: "mutate" as const,
					mutations: [],
					result: {
						error: `Form "${name}" can return to Results or App home after an empty-search registration. Leave post_submit out to return to Results, or set post_submit to app_home.`,
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
				...(formEntry && { entry: formEntry }),
			});
			// Tag under the parent module — the event log groups this
			// creation event with the rest of that module's activity so the
			// lifecycle UI renders "forms added to Patient module" as one
			// chapter rather than interleaved events per form index.
			const mutations = [
				...(formEntry ? searchFirstOnMutations(doc, moduleUuid) : []),
				...formMutations,
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
			return {
				kind: "mutate" as const,
				mutations: commit.mutations,
				result: {
					ok: true,
					formUuid,
					navigation: formNavigation(newDoc, formUuid),
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
