/**
 * The planner of a case list that always offers another menu's registration
 * form (`Module.caseListRegistrationForm`, the `always` arm), and the forms a
 * list may offer. The slot rides `updateModule.patch.caseListRegistrationForm`
 * whole, with `null` to clear, so one mutation sets the form, the button's
 * text and media, and where a worker goes after registering.
 *
 * The two arms share the one slot, so neither replaces the other in passing:
 * offering a form on the list is refused while the host offers its own form
 * after an empty search, and the reverse is refused while the list offers a
 * form (`afterEmptySearchOfferBlocked`, which every writer of the
 * `after-empty-search` arm asks first).
 *
 * Whether the gate admits a choice is not decided here: every choice carries
 * the batch that would offer it, and the surface reads the gate's verdict of
 * that batch (`hooks/useOfferedBatchRefusals.ts`), so the picker and the
 * commit cannot disagree.
 */

import type { Mutation } from "@/lib/doc/types";
import {
	type AlwaysOfferedRegistration,
	afterEmptySearchRegistrationFormOf,
	alwaysOfferedRegistrationOf,
	type BlueprintDoc,
	type Uuid,
} from "@/lib/domain";

/** The menus and forms the offer planners read, and nothing of a form's
 *  content. */
export type RegistrationOfferSource = Pick<
	BlueprintDoc,
	"modules" | "moduleOrder" | "forms" | "formOrder"
>;

export type AlwaysOfferedRegistrationPlan =
	| { readonly kind: "planned"; readonly mutations: Mutation[] }
	/** The host holds the `after-empty-search` arm. `message` is the agent's
	 *  sentence, `userMessage` the builder's. */
	| {
			readonly kind: "blocked";
			readonly message: string;
			readonly userMessage: string;
	  };

/**
 * Set the host's `always` arm whole, or clear it with `null`. Clearing a host
 * that holds no `always` arm plans no mutation. Setting is refused while the
 * host offers its own form after an empty search: the two arms share one
 * slot, and replacing one with the other is a decision the person makes.
 */
export function alwaysOfferedRegistrationMutations(
	doc: RegistrationOfferSource,
	hostUuid: Uuid,
	slot: AlwaysOfferedRegistration | null,
): AlwaysOfferedRegistrationPlan {
	if (slot === null)
		return {
			kind: "planned",
			mutations:
				alwaysOfferedRegistrationOf(doc, hostUuid) === undefined
					? []
					: [
							{
								kind: "updateModule",
								uuid: hostUuid,
								patch: { caseListRegistrationForm: null },
							},
						],
		};
	const afterEmptySearch = afterEmptySearchRegistrationFormOf(doc, hostUuid);
	if (afterEmptySearch !== undefined) {
		const host = doc.modules[hostUuid]?.name ?? "";
		const form = doc.forms[afterEmptySearch]?.name ?? "";
		const lead = `"${host}" already offers "${form}" after a search finds nothing. You can stop offering that`;
		return {
			kind: "blocked",
			message: `${lead} (case_list_registration null on update_form), and then offer a form on the list.`,
			userMessage: `${lead}, and then offer a form on the list.`,
		};
	}
	return {
		kind: "planned",
		mutations: [
			{
				kind: "updateModule",
				uuid: hostUuid,
				patch: { caseListRegistrationForm: slot },
			},
		],
	};
}

/**
 * The refusal of the other direction of the switch: naming a form the host
 * offers after an empty search (`caseListRegistrationForm.ts`) while its list
 * always offers another menu's form. The two arms share one slot, so the
 * offer would replace the list's Register button, its media and where it
 * returns. Undefined where the host holds no `always` arm. `message` is the
 * agent's sentence, `userMessage` the builder's.
 */
export function afterEmptySearchOfferBlocked(
	doc: BlueprintDoc,
	hostUuid: Uuid,
): { readonly message: string; readonly userMessage: string } | undefined {
	const always = alwaysOfferedRegistrationOf(doc, hostUuid);
	if (always === undefined) return undefined;
	const host = doc.modules[hostUuid]?.name ?? "";
	const form = doc.forms[always.formUuid]?.name ?? "";
	const lead = `"${host}" already offers "${form}" from its case list. You can stop offering that`;
	return {
		message: `${lead} (register_from_case_list null on update_module), and then offer a form after a search finds nothing.`,
		userMessage: `${lead}, and then offer a form after a search finds nothing.`,
	};
}

export interface AlwaysOfferedRegistrationChoice {
	readonly formUuid: Uuid;
	readonly formName: string;
	readonly moduleUuid: Uuid;
	readonly moduleName: string;
	/** The batch that would offer this form on the host. */
	readonly mutations: readonly Mutation[];
}

/**
 * Every registration form of the host's case type outside the host, in
 * module then form order, each with the batch that offers it under the
 * host's stored label, media and `afterSubmit` (`case-list` on a first
 * offer). None where the host has no case type, and none where the planner
 * is blocked.
 */
export function alwaysOfferedRegistrationChoices(
	doc: RegistrationOfferSource,
	hostUuid: Uuid,
): readonly AlwaysOfferedRegistrationChoice[] {
	const host = doc.modules[hostUuid];
	if (host?.caseType === undefined) return [];
	if (afterEmptySearchRegistrationFormOf(doc, hostUuid) !== undefined)
		return [];
	const stored = alwaysOfferedRegistrationOf(doc, hostUuid);
	const choices: AlwaysOfferedRegistrationChoice[] = [];
	for (const moduleUuid of doc.moduleOrder) {
		if (moduleUuid === hostUuid) continue;
		const mod = doc.modules[moduleUuid];
		if (mod?.caseType !== host.caseType) continue;
		for (const formUuid of doc.formOrder[moduleUuid] ?? []) {
			const form = doc.forms[formUuid];
			if (form?.type !== "registration") continue;
			const plan = alwaysOfferedRegistrationMutations(doc, hostUuid, {
				kind: "always",
				formUuid,
				...(stored?.label !== undefined && { label: stored.label }),
				...(stored?.icon !== undefined && { icon: stored.icon }),
				...(stored?.audioLabel !== undefined && {
					audioLabel: stored.audioLabel,
				}),
				afterSubmit: stored?.afterSubmit ?? "case-list",
			});
			if (plan.kind === "blocked") return [];
			choices.push({
				formUuid,
				formName: form.name,
				moduleUuid,
				moduleName: mod.name,
				mutations: plan.mutations,
			});
		}
	}
	return choices;
}
