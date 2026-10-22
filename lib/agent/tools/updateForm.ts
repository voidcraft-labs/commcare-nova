/** Patch form metadata and navigation through the shared canonical workspace. */
import { z } from "zod";
import {
	setFormDisplayConditionMutation,
	setFormHiddenFromMenuMutation,
} from "@/lib/doc/displayConditionMutations";
import { formRecordNameMutations } from "@/lib/doc/formRecordName";
import { findContainingForm } from "@/lib/doc/mutations/helpers";
import { noMatchesFormEntryMutations } from "@/lib/doc/searchNoMatchesForm";
import type { ConnectConfig, PostSubmitDestination } from "@/lib/domain";
import {
	appConnectIds,
	asUuid,
	formRootFieldIds,
	moduleOpensOnSearch,
	POST_SUBMIT_DESTINATIONS,
} from "@/lib/domain";
import { conditionSchema } from "@/lib/domain/expression";
import { formLogicSchema } from "@/lib/domain/expression/types";
import { formNavigation } from "@/lib/preview/engine/navigationProjection";
import {
	refineFormConnectMutations,
	updateFormMutations,
} from "../blueprintHelpers";
import {
	closeConditionInputSchema,
	connectFormPatchSchema,
} from "../planningSchemas";
import type { ToolInvocationContext } from "../workspace/types";
import {
	applyToDoc,
	guardedMutate,
	type MutatingToolResult,
	toToolErrorResult,
} from "./common";
import { enforceConnectIds } from "./shared/connectIds";
import { buildConnectConfig } from "./shared/connectInput";
import {
	formAddressSchema,
	resolveFormAddress,
} from "./shared/entityAddresses";
import {
	FORM_ENTRY_DESCRIPTION,
	formEntryInputSchema,
} from "./shared/formEntry";
import type {
	MutationSuccess,
	ToolCallSummary,
} from "./shared/toolCallSummary";

export const updateFormInputSchema = formAddressSchema
	.extend({
		name: z
			.string()
			.min(1)
			.optional()
			.describe("New form name. Leave it out to keep the current name."),
		purpose: z
			.string()
			.nullable()
			.optional()
			.describe("What this form is for. Null removes the description."),
		recordName: formLogicSchema
			.optional()
			.describe(
				"Name of the record this form creates or updates, using an answer or an expression.",
			),
		close_condition: closeConditionInputSchema
			.nullable()
			.optional()
			.describe(
				'Close forms only. Set conditional close; use operator "selected" for multi-select fields. Pass null to make the close unconditional again; leave it out to keep the current condition.',
			),
		post_submit: z
			.enum(POST_SUBMIT_DESTINATIONS)
			.nullable()
			.optional()
			.describe(
				'Post-submit destination: "app_home", "firstMenu" (the app\'s first menu, which lists its modules; in Web Apps the same screen as "app_home"), "module" (its normal opening screen), "parentMenu" (the parent module, with its selection kept), or "previous" (the preceding selection or task shown by the resolved navigation result). null resets to the default: "app_home" for registration/survey, and for followup/close the first the module offers of "previous", "module", "firstMenu". A module offers "previous" unless it or its parent selects several cases, it opens on Search, or it is off the menu; "module" unless its parent selects several cases or it is off the menu; "parentMenu" when its parent neither selects several cases nor is off the menu. A destination the module does not offer is refused. For entry search-no-matches, only explicit firstMenu is supported; null restores return to Results, which requires single-case selection. With conditional after-submit links and no otherwise link this is where the form goes when none match, and it must be explicit.',
			),
		connect: connectFormPatchSchema
			.nullable()
			.optional()
			.describe(
				"Refine this already-participating form after the app has a Connect mode: omitted sub-configs keep their current value, null removes one sub-config only while another remains, and a stated one replaces it. Use configureConnect/configure_connect for enable, mode switch, participant-set changes, or disable; whole-slot null is refused here.",
			),
		displayCondition: conditionSchema
			.nullable()
			.optional()
			.describe(
				"Running-app visibility rule. A Predicate sets it, null removes it, omission keeps it. It applies while the item is on the menu; hiddenFromMenu takes it off whatever the condition, and a condition that starts with never is refused, since hiddenFromMenu is how that is said.",
			),
		hiddenFromMenu: z
			.literal(true)
			.nullable()
			.optional()
			.describe(
				"true takes the form off the menu, null puts it back, omission keeps it. Off the menu, the form opens on Android from an after-submit link or an entry point, and in Web Apps only from an entry point that ignores display conditions.",
			),
		entry: formEntryInputSchema
			.nullable()
			.optional()
			.describe(FORM_ENTRY_DESCRIPTION),
	})
	.strict();

export type UpdateFormInput = z.infer<typeof updateFormInputSchema>;

/** Human-readable success string or an error record. */
export type UpdateFormResult =
	| (MutationSuccess & {
			close?: "conditional" | "unconditional";
			display?: "conditional" | "always";
			hiddenFromMenu?: boolean;
			postSubmit?: string;
			navigation?: ReturnType<typeof formNavigation>;
			entry?: "menu" | "search-no-matches";
			searchFirst?: boolean;
			clearedSearchDefaults?: string[];
	  })
	| { error: string };

export const updateFormTool = {
	description:
		"Edit a form's name, purpose, record naming rule, close condition, Connect settings or after-submit navigation.",
	inputSchema: updateFormInputSchema,
	async execute(
		input: UpdateFormInput,
		ctx: ToolInvocationContext,
	): Promise<MutatingToolResult<UpdateFormResult>> {
		const doc = ctx.snapshot.doc;
		const {
			moduleUuid: rawModuleUuid,
			formUuid: rawFormUuid,
			name,
			purpose,
			recordName,
			close_condition,
			post_submit,
			connect,
			displayCondition,
			hiddenFromMenu,
			entry,
		} = input;
		try {
			const address = resolveFormAddress(doc, {
				moduleUuid: rawModuleUuid,
				formUuid: rawFormUuid,
			});
			if (!address.ok) {
				return {
					kind: "mutate" as const,
					mutations: [],
					result: { error: address.error },
				};
			}
			const { formUuid, form: existing, module } = address;

			// Build the helper's patch shape. The SA's tool arg uses
			// `field` directly — no translation needed since the SA speaks
			// domain vocabulary. Omitted = leave unchanged; `null` = clear
			// (a `null` patch entry — the reducer deletes the key).
			const patch: Parameters<typeof updateFormMutations>[2] = {};
			let refinedConnect: ConnectConfig | undefined;
			if (name !== undefined) patch.name = name;
			if (purpose !== undefined) patch.purpose = purpose;
			if (close_condition === null) patch.closeCondition = null;
			if (close_condition != null) {
				const fieldUuid = asUuid(close_condition.fieldUuid);
				if (
					doc.fields[fieldUuid] === undefined ||
					findContainingForm(doc, fieldUuid) !== formUuid
				) {
					return {
						kind: "mutate" as const,
						mutations: [],
						result: {
							error: `Field UUID "${close_condition.fieldUuid}" is not in form "${existing.name}".`,
						},
					};
				}
				patch.closeCondition = {
					field: fieldUuid,
					answer: close_condition.answer,
					...(close_condition.operator && {
						operator: close_condition.operator,
					}),
				};
			}
			if (post_submit === null) patch.postSubmit = null;
			if (post_submit != null) {
				patch.postSubmit = post_submit as PostSubmitDestination;
			}
			if (entry != null) {
				/* No-matches registration can return to Results or explicitly to the
				 * app's first menu. */
				const effectivePostSubmit =
					post_submit === undefined ? existing.postSubmit : post_submit;
				const carried = [
					...(effectivePostSubmit != null && effectivePostSubmit !== "firstMenu"
						? ["post_submit"]
						: []),
					...(displayCondition != null ||
					(displayCondition === undefined &&
						existing.displayCondition !== undefined)
						? ["displayCondition"]
						: []),
					...(hiddenFromMenu != null ||
					(hiddenFromMenu === undefined && existing.hiddenFromMenu === true)
						? ["hiddenFromMenu"]
						: []),
					...((existing.formLinks?.length ?? 0) > 0
						? ["after-submit links"]
						: []),
				];
				if (carried.length > 0) {
					return {
						kind: "mutate" as const,
						mutations: [],
						result: {
							error: `Form "${existing.name}" cannot open after a search finds no matches while it carries ${carried.join(", ")}: that form can return to Results or First menu and is on no menu. Clear ${carried.length === 1 ? "it" : "them"} (post_submit: null, displayCondition: null, hiddenFromMenu: null, remove_form_link) in this call or before, then set entry.`,
						},
					};
				}
			}
			if (connect !== undefined) {
				if (doc.connectType === null) {
					return {
						kind: "mutate" as const,
						mutations: [],
						result: {
							error:
								"CommCare Connect is not enabled. Use configureConnect/configure_connect with the complete nonempty participant set.",
						},
					};
				}
				if (existing.connect === undefined) {
					return {
						kind: "mutate" as const,
						mutations: [],
						result: {
							error:
								"This form is not a Connect participant. Use configureConnect/configure_connect to replace the complete participant set.",
						},
					};
				}
				if (connect === null) {
					return {
						kind: "mutate" as const,
						mutations: [],
						result: {
							error:
								"Removing a form from Connect changes the app-wide participant set. Use configureConnect/configure_connect with the complete target.",
						},
					};
				}
				// Structural partial-update merge of exact XPath AST slots. Per
				// sub-config: omitted keeps the existing one, an explicit
				// null REMOVES it, a stated one replaces it.
				const merged = buildConnectConfig(connect, existing.connect);
				if (
					!merged.learn_module &&
					!merged.assessment &&
					!merged.deliver_unit &&
					!merged.task
				) {
					return {
						kind: "mutate" as const,
						mutations: [],
						result: {
							error:
								"Removing the form's final Connect section changes the app-wide participant set. Use configureConnect/configure_connect with the complete target.",
						},
					};
				} else {
					// Force connect ids correct at the source: autofill omitted
					// ids, reject explicit-invalid ids (fail the call, write
					// nothing). `existingIds` excludes this form's own ids so a
					// re-patch of an unchanged id doesn't read as a self-conflict.
					const enforced = enforceConnectIds(
						merged,
						doc.connectType,
						module.name,
						name ?? existing.name,
						appConnectIds(doc, formUuid),
						formRootFieldIds(doc, formUuid),
					);
					if (!enforced.ok) {
						return {
							kind: "mutate" as const,
							mutations: [],
							result: { error: enforced.error },
						};
					}
					refinedConnect = enforced.config;
				}
			}

			// Compute the mutations, apply via Immer, and persist through
			// the shared context so both surfaces write the same stream +
			// log + Postgres trio.
			const mutations = [
				...updateFormMutations(doc, formUuid, patch),
				...(refinedConnect === undefined
					? []
					: refineFormConnectMutations(doc, formUuid, refinedConnect)),
				/* Omission keeps the current condition; an explicit null clears it.
				 * The mutation spells the clear as null so it survives JSONB, SSE,
				 * and replay — `undefined` would be dropped and the stale condition
				 * would reappear on the next save. */
				...(displayCondition === undefined
					? []
					: [
							setFormDisplayConditionMutation(
								formUuid,
								displayCondition ?? undefined,
							),
						]),
				/* Omission keeps the flag; true takes the form off the menu and
				 * null puts it back. */
				...(hiddenFromMenu === undefined
					? []
					: [setFormHiddenFromMenuMutation(formUuid, hiddenFromMenu === true)]),
				/* Setting the entry also opens the module on Search when it does
				 * not already, in this same batch (`searchNoMatchesForm.ts`). */
				...(entry === undefined
					? []
					: noMatchesFormEntryMutations(
							doc,
							module.uuid,
							formUuid,
							entry === null
								? null
								: {
										kind: entry.kind,
										...(entry.label != null && { label: entry.label }),
									},
						)),
			];
			if (recordName !== undefined)
				mutations.push(
					...formRecordNameMutations(
						applyToDoc(doc, mutations),
						formUuid,
						recordName,
						[...(ctx.preparedRecordNames?.values() ?? [])].find(
							(prepared) => prepared.form.formUuid === formUuid,
						),
					),
				);
			const commit = await guardedMutate(ctx, mutations, `form:${formUuid}`);
			if (!commit.ok) {
				return {
					kind: "mutate" as const,
					mutations: [],
					result: { error: commit.error },
				};
			}
			const newDoc = commit.newDoc;

			const formAfter = newDoc.forms[formUuid];
			if (!formAfter) {
				return {
					kind: "mutate" as const,
					mutations: commit.mutations,
					result: {
						error: `Form ${formUuid} not found after update`,
					},
				};
			}
			const clearedSearchDefaults =
				entry === null
					? mutations.flatMap((mutation) =>
							mutation.kind === "updateField" &&
							"default_value" in mutation.patch &&
							mutation.patch.default_value === null
								? [mutation.uuid]
								: [],
						)
					: [];
			return {
				kind: "mutate" as const,
				mutations: commit.mutations,
				result: {
					ok: true,
					navigation: formNavigation(newDoc, formUuid),
					...(close_condition !== undefined && {
						close: formAfter.closeCondition
							? ("conditional" as const)
							: ("unconditional" as const),
					}),
					...(displayCondition !== undefined && {
						display: formAfter.displayCondition
							? ("conditional" as const)
							: ("always" as const),
					}),
					...(hiddenFromMenu !== undefined && {
						hiddenFromMenu: formAfter.hiddenFromMenu === true,
					}),
					...(post_submit !== undefined && {
						postSubmit: formAfter.postSubmit ?? "form-type-default",
					}),
					...(entry !== undefined && {
						entry:
							entry === null
								? ("menu" as const)
								: ("search-no-matches" as const),
						searchFirst: moduleOpensOnSearch(newDoc.modules[module.uuid]),
					}),
					...(clearedSearchDefaults.length > 0 && { clearedSearchDefaults }),
					summary: {
						location: module.name,
						subject: formAfter.name,
					} satisfies ToolCallSummary,
				},
			};
		} catch (err) {
			return toToolErrorResult(err);
		}
	},
};
