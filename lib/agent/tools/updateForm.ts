/** Patch form metadata and navigation through the shared canonical workspace. */
import { z } from "zod";
import {
	formBehaviorTextChoices,
	formBehaviorTextIssue,
} from "@/lib/commcare/xform/behaviorTexts";
import { afterEmptySearchOfferBlocked } from "@/lib/doc/alwaysOfferedRegistration";
import { caseListRegistrationMutations } from "@/lib/doc/caseListRegistrationForm";
import { mutationCommitVerdict } from "@/lib/doc/commitVerdicts";
import {
	setFormDisplayConditionMutation,
	setFormHiddenFromMenuMutation,
} from "@/lib/doc/displayConditionMutations";
import { formRecordNameMutations } from "@/lib/doc/formRecordName";
import type {
	BlueprintDoc,
	Form,
	PostSubmitDestination,
	Uuid,
} from "@/lib/domain";
import {
	afterEmptySearchRegistrationFormOf,
	moduleFormsReadSearch,
	POST_SUBMIT_DESTINATIONS,
} from "@/lib/domain";
import { conditionSchema } from "@/lib/domain/expression";
import { formLogicSchema, type ItextUnit } from "@/lib/domain/expression/types";
import { formRootNameSchema } from "@/lib/domain/formAnswerRoot";
import { behaviorTextSchema, formBehaviorRoles } from "@/lib/domain/forms";
import { menuBadgeSchema } from "@/lib/domain/menuBadge";
import { formNavigation } from "@/lib/preview/engine/navigationProjection";
import { updateFormMutations } from "../blueprintHelpers";
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
import {
	formAddressSchema,
	resolveFormAddress,
} from "./shared/entityAddresses";
import { precheckLookupContext } from "./shared/platformPrecheck";
import type {
	MutationSuccess,
	ToolCallSummary,
} from "./shared/toolCallSummary";

/** How a form behavior names the text that holds it, from the question tree getForm returns. */
const BEHAVIOR_TEXT_NAMING =
	"Name a question's text as { field: the question's id, role: field-label, field-hint, field-help, field-validation-message, field-first-add-label or field-add-label }, and a choice's as { field, role: select-option-label, option: the choice's value }; alsoUsedBy lists other texts written the same that share it.";

export const updateFormInputSchema = formAddressSchema
	.extend({
		name: z
			.string()
			.min(1)
			.optional()
			.describe("New form name. Leave it out to keep the current name."),
		submitLabel: z
			.string()
			.nullable()
			.optional()
			.describe(
				"Wording of the submit button in Web Apps. Null restores the platform wording for the source language.",
			),
		answerRoot: formRootNameSchema
			.nullable()
			.optional()
			.describe(
				"The first name in every submitted answer address. Set this when an existing reporting or data workflow expects a particular name. Null restores data.",
			),
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
		badge: menuBadgeSchema
			.nullable()
			.optional()
			.describe(
				"A short label beside this item on the worker’s menu. Give it text or a calculation. A null value removes the badge.",
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
		capture_location: z
			.boolean()
			.optional()
			.describe(
				"Whether this form requests the Android device's location when it opens. False uses the app setting. Connect always requests location. Web Apps leaves the location empty.",
			),
		automaticSubmissionText: z
			.union([z.literal(true), behaviorTextSchema])
			.nullable()
			.optional()
			.describe(
				`Submit this form automatically in Web Apps when it opens and its answers are valid. True lets Nova choose a question label in this form to hold the setting; or name a text of this form. ${BEHAVIOR_TEXT_NAMING} Null restores manual submission.`,
			),
		skipAutomaticSyncText: behaviorTextSchema
			.nullable()
			.optional()
			.describe(
				"Mark this form so Web Apps skips a sync after it submits. Web Apps syncs after a form only in an app set to sync after each form, which Nova apps never are, so this changes nothing for workers; it keeps a setting an app brought in holds. Name a text of this form as automaticSubmissionText does. Null removes the setting.",
			),
		validateChangedAnswersText: behaviorTextSchema
			.nullable()
			.optional()
			.describe(
				"In Web Apps, recheck changed answers and blanks at submission. A previously accepted nonblank answer can stay accepted after a related answer changes. Name a text of this form as automaticSubmissionText does. Null removes the setting.",
			),
		savedFormDescriptorText: behaviorTextSchema
			.nullable()
			.optional()
			.describe(
				"Use a text from this form for its label in Android's saved and incomplete forms lists. The label reads the answers as the worker saves the form. Name a text as automaticSubmissionText does. Null removes the label.",
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

/**
 * The first text of the form, question labels first, that can hold automatic
 * submission beside the form's other behaviors as `patch` leaves them: one the
 * commit gate would admit, never one another behavior holds or an earlier
 * equal text takes over.
 */
function freeBehaviorText(
	doc: BlueprintDoc,
	formUuid: Uuid,
	patch: Parameters<typeof updateFormMutations>[2],
): ItextUnit | undefined {
	const form = doc.forms[formUuid];
	if (form === undefined) return undefined;
	const others: Form = { ...form };
	for (const role of formBehaviorRoles) {
		if (role === "automaticSubmissionText" || patch[role] === undefined)
			continue;
		const value = patch[role];
		if (value === null) delete others[role];
		else others[role] = value;
	}
	const options = formBehaviorTextChoices(doc, formUuid);
	const ranked = [
		...options.filter((option) => option.questionLabel),
		...options.filter((option) => !option.questionLabel),
	];
	return ranked.find(
		(option) =>
			formBehaviorTextIssue(
				{
					...doc,
					forms: {
						...doc.forms,
						[formUuid]: {
							...others,
							automaticSubmissionText: { carrier: option.unit },
						},
					},
				},
				formUuid,
			) === undefined,
	)?.unit;
}

export const updateFormTool = {
	description:
		"Edit a form's name, purpose, record naming rule, open and close conditions, visibility, menu badge, automatic submission, after-submit navigation, or whether it is its menu's registration from the case list.",
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
			answerRoot,
			purpose,
			submitLabel,
			recordName,
			open_condition,
			close_condition,
			post_submit,
			badge,
			displayCondition,
			hiddenFromMenu,
			capture_location,
			automaticSubmissionText,
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
			if (name !== undefined) patch.name = name;
			if (answerRoot !== undefined)
				patch.dataRootName = answerRoot === "data" ? null : answerRoot;
			if (purpose !== undefined) patch.purpose = purpose;
			if (submitLabel !== undefined)
				patch.submitLabel = submitLabel === null ? {} : { text: submitLabel };
			if (capture_location !== undefined)
				patch.captureLocation = capture_location ? true : null;
			for (const role of formBehaviorRoles) {
				if (role !== "automaticSubmissionText" && input[role] !== undefined)
					patch[role] = input[role];
			}
			if (automaticSubmissionText === true) {
				if (!existing.automaticSubmissionText) {
					const chosen = freeBehaviorText(doc, formUuid, patch);
					if (chosen === undefined)
						return {
							kind: "mutate",
							mutations: [],
							result: {
								error:
									formBehaviorTextChoices(doc, formUuid).length === 0
										? "A question or choice with text lets this form submit automatically. Add one and try again."
										: "Every question and choice text in this form already holds another setting or matches an earlier text. You can add a question with its own text, or name a text for automatic submission.",
							},
						};
					patch.automaticSubmissionText = { carrier: chosen };
				}
			} else if (automaticSubmissionText !== undefined)
				patch.automaticSubmissionText = automaticSubmissionText;
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
				/* The menu's case list holds one registration offer: one that
				 * always offers another menu's form is not replaced in passing. */
				const armBlocked = afterEmptySearchOfferBlocked(doc, module.uuid);
				if (armBlocked !== undefined)
					return {
						kind: "mutate" as const,
						mutations: [],
						result: { error: armBlocked.message },
					};
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
					...(badge != null ||
					(badge === undefined && existing.badge !== undefined)
						? ["badge"]
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
							error: `Form "${existing.name}" can't be its menu's registration from the case list while it carries ${carried.join(", ")}: that form returns to the results or goes to the first menu, and is on no menu. Clear ${carried.length === 1 ? "it" : "them"} (post_submit: null, displayCondition: null, hiddenFromMenu: null, badge: null, remove_form_link) in this call or before, then set case_list_registration.`,
						},
					};
				}
			}
			// Compute the mutations, apply via Immer, and persist through
			// the shared context so both surfaces write the same stream +
			// log + Postgres trio.
			const mutations = [
				...(badge === undefined
					? []
					: [
							{ kind: "updateForm" as const, uuid: formUuid, patch: { badge } },
						]),
				...updateFormMutations(doc, formUuid, patch),
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
