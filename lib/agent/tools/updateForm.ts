/** Patch form metadata and navigation through the shared canonical workspace. */
import { z } from "zod";
import { caseListRegistrationMutations } from "@/lib/doc/caseListRegistrationForm";
import { mutationCommitVerdict } from "@/lib/doc/commitVerdicts";
import {
	setFormDisplayConditionMutation,
	setFormHiddenFromMenuMutation,
} from "@/lib/doc/displayConditionMutations";
import { formRecordNameMutations } from "@/lib/doc/formRecordName";
import type { ConnectConfig, PostSubmitDestination } from "@/lib/domain";
import {
	afterEmptySearchRegistrationFormOf,
	appConnectIds,
	formRootFieldIds,
	moduleFormsReadSearch,
	POST_SUBMIT_DESTINATIONS,
} from "@/lib/domain";
import { conditionSchema } from "@/lib/domain/expression";
import { formLogicSchema } from "@/lib/domain/expression/types";
import { formNavigation } from "@/lib/preview/engine/navigationProjection";
import {
	refineFormConnectMutations,
	updateFormMutations,
} from "../blueprintHelpers";
import { connectFormPatchSchema } from "../planningSchemas";
import type { ToolInvocationContext } from "../workspace/types";
import {
	applyToDoc,
	guardedMutate,
	type MutatingToolResult,
	toToolErrorResult,
} from "./common";
import {
	CASE_LIST_REGISTRATION_DESCRIPTION,
	caseListRegistrationEntry,
	caseListRegistrationInputSchema,
} from "./shared/caseListRegistration";
import { enforceConnectIds } from "./shared/connectIds";
import { buildConnectConfig } from "./shared/connectInput";
import {
	formAddressSchema,
	resolveFormAddress,
} from "./shared/entityAddresses";
import { precheckLookupContext } from "./shared/platformPrecheck";
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
		open_condition: formLogicSchema
			.nullable()
			.optional()
			.describe(
				"Registration forms only. The case is created only when this holds; null creates it on every submission. Read form answers as any form expression does. Leave it out to keep the current condition.",
			),
		close_condition: formLogicSchema
			.nullable()
			.optional()
			.describe(
				"Registration and close forms. On a registration, the case it creates also closes when this holds, and true() closes it on every submission; null keeps it open. On a close form, the case closes only when this holds, and null closes it on every submission. Read form answers as any form expression does. Leave it out to keep the current condition.",
			),
		post_submit: z
			.enum(POST_SUBMIT_DESTINATIONS)
			.nullable()
			.optional()
			.describe(
				'Post-submit destination: "app_home", "firstMenu" (the app\'s first menu, which lists its modules; in Web Apps the same screen as "app_home"), "module" (its normal opening screen), "parentMenu" (the parent module, with its selection kept), or "previous" (the preceding selection or task shown by the resolved navigation result). null resets to the default: "app_home" for registration/survey, and for followup/close the first the module offers of "previous", "module", "firstMenu". A module offers "previous" unless it or its parent selects several cases, its forms read the search, or it is off the menu; "module" unless its parent selects several cases or it is off the menu; "parentMenu" when its parent neither selects several cases nor is off the menu. A destination the module does not offer is refused. A form that is its menu\'s registration from the case list returns to the results after submit, or goes to "firstMenu" when that is set, which a menu choosing several cases requires. A form with after-submit destinations takes no post_submit; set where it goes when none runs with setFormOtherwise/set_form_otherwise.',
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
		plain_text: z
			.boolean()
			.nullable()
			.optional()
			.describe(
				"true turns text formatting off for the whole form, whatever a text's own plain_label or plain_help says: every label shows as typed, and every choice and help text shows as typed on Android (Web Apps formats those two either way). false or null turns it back on.",
			),
		case_list_registration: caseListRegistrationInputSchema
			.nullable()
			.optional()
			.describe(
				`${CASE_LIST_REGISTRATION_DESCRIPTION} null makes it a menu form again, turns formsReadSearch off and removes Search-based starting values; leave it out to keep it.`,
			),
	})
	.strict();

export type UpdateFormInput = z.infer<typeof updateFormInputSchema>;

/** Human-readable success string or an error record. */
export type UpdateFormResult =
	| (MutationSuccess & {
			open?: "conditional" | "unconditional";
			close?: "conditional" | "unconditional";
			display?: "conditional" | "always";
			hiddenFromMenu?: boolean;
			postSubmit?: string;
			navigation?: ReturnType<typeof formNavigation>;
			caseListRegistration?: boolean;
			formsReadSearch?: boolean;
			clearedSearchDefaults?: string[];
	  })
	| { error: string };

export const updateFormTool = {
	description:
		"Edit a form's name, purpose, record naming rule, open and close conditions, Connect settings, after-submit navigation, or whether it is its menu's registration from the case list.",
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
			open_condition,
			close_condition,
			post_submit,
			connect,
			displayCondition,
			hiddenFromMenu,
			plain_text,
			case_list_registration,
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
			if (plain_text !== undefined)
				patch.plainText = plain_text === true ? true : null;
			// Each condition arrives parsed in its own form slot; the checker
			// reports a question the form does not have, and the gate refuses
			// an open condition on a form that is not a registration.
			if (open_condition !== undefined) patch.openCondition = open_condition;
			if (close_condition !== undefined) patch.closeCondition = close_condition;
			if (post_submit === null) patch.postSubmit = null;
			if (post_submit != null) {
				patch.postSubmit = post_submit as PostSubmitDestination;
			}
			if (case_list_registration != null) {
				/* A registration from the case list returns to the results or
				 * explicitly to the app's first menu, and is on no menu. */
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
							error: `Form "${existing.name}" can't be its menu's registration from the case list while it carries ${carried.join(", ")}: that form returns to the results or goes to the first menu, and is on no menu. Clear ${carried.length === 1 ? "it" : "them"} (post_submit: null, displayCondition: null, hiddenFromMenu: null, remove_form_link) in this call or before, then set case_list_registration.`,
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
				/* Setting the registration from the case list also turns on Forms
				 * read the search in this same batch; null turns it off and drops
				 * the starting values read from the search
				 * (`caseListRegistrationForm.ts`). */
				...(case_list_registration === undefined
					? []
					: caseListRegistrationMutations(
							doc,
							module.uuid,
							formUuid,
							case_list_registration === null
								? null
								: caseListRegistrationEntry(case_list_registration),
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
			/* Private work stages a batch whatever its findings, so a
			 * post_submit beside destinations is refused at this call, in the
			 * gate's own words for the same batch. */
			if (post_submit != null && (existing.formLinks?.length ?? 0) > 0) {
				const verdict = mutationCommitVerdict(
					doc,
					mutations,
					await precheckLookupContext(ctx, doc, applyToDoc(doc, mutations)),
				);
				const beside = verdict.ok
					? undefined
					: verdict.findings.find(
							(finding) => finding.code === "POST_SUBMIT_BESIDE_FORM_LINKS",
						);
				if (beside !== undefined) {
					return {
						kind: "mutate" as const,
						mutations: [],
						result: { error: beside.message },
					};
				}
			}
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
				case_list_registration === null
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
					...(open_condition !== undefined && {
						open: formAfter.openCondition
							? ("conditional" as const)
							: ("unconditional" as const),
					}),
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
					...(case_list_registration !== undefined && {
						caseListRegistration:
							afterEmptySearchRegistrationFormOf(newDoc, module.uuid) ===
							formUuid,
						formsReadSearch: moduleFormsReadSearch(newDoc.modules[module.uuid]),
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
