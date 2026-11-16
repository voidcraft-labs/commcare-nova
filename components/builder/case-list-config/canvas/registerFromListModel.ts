/**
 * The pure model of a case list's "Register from this list" setting: the
 * copy it shows for the host's shape, the whole slot each change writes, and
 * the note that names the form's own after-submit where that is in force.
 * The component (`RegisterFromListSetting.tsx`) renders it and commits the
 * slot through `lib/doc/alwaysOfferedRegistration.ts`.
 */

import { destinationLabel } from "@/components/builder/form-links/afterSubmitCopy";
import type { RegisterFromListFacts } from "@/lib/doc/hooks/useRegisterFromList";
import type {
	AlwaysOfferedRegistration,
	CaseListRegistrationReturn,
	Uuid,
} from "@/lib/domain";

export const REGISTER_FROM_LIST_COPY = {
	heading: "Register from this list",
	lede: "Offer a registration form on the case list, so workers can look for a case before adding a new one.",
	pickerLabel: "Form",
	pickerNone: "Don't offer one",
	buttonTextLabel: "Button text",
	iconLabel: "Button icon",
	audioLabel: "Spoken label",
	choiceGroupLabel: "After registering",
	choiceCaseList: "Back to this list",
	choiceNewCase: "Continue with the new case",
} as const;

/** A picker option: `<form> in <menu>`. */
export function registerChoiceLabel(
	formName: string,
	moduleName: string,
): string {
	return `${formName} in ${moduleName}`;
}

/** The empty state, where no other menu has a registration form of the type. */
export function registerFromListEmptyState(caseType: string): string {
	return `Once another menu has a registration form for ${caseType}, you can offer it here.`;
}

/** While the host offers its own form after an empty search. */
export function afterEmptySearchNotice(formName: string): string {
	return `This list already offers ${formName} when a search finds nothing. You can change that under When no cases match.`;
}

/** The helper under each After registering choice, for the host's shape. */
export function afterRegisteringHelpers(
	facts: Pick<RegisterFromListFacts, "hostName" | "bare" | "caseFirst">,
): Readonly<Record<CaseListRegistrationReturn, string>> {
	return {
		"case-list":
			!facts.caseFirst && !facts.bare
				? `The worker returns to ${facts.hostName}, where they choose a form.`
				: "The worker returns to the list, where the new case now shows.",
		"new-case": facts.bare
			? "This list has no forms to go on to, so the worker returns to the list."
			: "The worker goes on to this menu's forms for the case they registered. If the form registered no case, they return to the list.",
	};
}

/**
 * The note under After registering where the form's own after-submit is in
 * force: CommCare HQ then writes no return frame, so the form goes where its
 * own after-submit says from the list too. Undefined where the choice above
 * applies.
 */
export function ownAfterSubmitNote(
	own: RegisterFromListFacts["ownAfterSubmit"],
): { readonly text: string; readonly buttonLabel: string } | undefined {
	if (own === undefined) return undefined;
	const destination =
		own.destination === "links"
			? "its after-submit links"
			: destinationLabel(own.destination);
	return {
		text: `${own.formName} has its own After submit (${destination}), so it goes there from this list too. You can set ${own.formName}'s After submit to Home to use the choice above.`,
		buttonLabel: `Open ${own.formName}'s After submit`,
	};
}

/** The whole slot one change writes: the stored arm with the change over
 *  it. A first offer goes back to the list after registering. An emptied
 *  label or media slot is absent, never stored empty. */
export function slotWith(
	stored: AlwaysOfferedRegistration | undefined,
	formUuid: Uuid,
	change: Partial<Omit<AlwaysOfferedRegistration, "kind" | "formUuid">>,
): AlwaysOfferedRegistration {
	const merged = {
		label: stored?.label,
		icon: stored?.icon,
		audioLabel: stored?.audioLabel,
		afterSubmit: stored?.afterSubmit ?? ("case-list" as const),
		...change,
	};
	const label =
		merged.label === undefined || merged.label.trim() === ""
			? undefined
			: merged.label.trim();
	return {
		kind: "always",
		formUuid,
		...(label !== undefined && { label }),
		...(merged.icon !== undefined && { icon: merged.icon }),
		...(merged.audioLabel !== undefined && { audioLabel: merged.audioLabel }),
		afterSubmit: merged.afterSubmit,
	};
}

/** The form's side: the lists that always offer it. */
export function alsoOfferedOnLine(hostNames: readonly string[]): string {
	if (hostNames.length === 1)
		return `Also offered on ${hostNames[0]}'s case list`;
	const last = hostNames[hostNames.length - 1];
	return `Also offered on the case lists of ${hostNames.slice(0, -1).join(", ")} and ${last}`;
}

/** A refusal the gate gave one change of the setting, held with what it
 *  answered: the case list and the document it was given for. */
export interface HeldRegisterRefusal {
	readonly message: string;
	readonly moduleUuid: Uuid;
	readonly revision: object;
}

/** The refusal the setting shows: only while it answers this case list and
 *  this document. Another case list, an undo or a peer's edit leaves it
 *  behind, since its cause may be gone. */
export function shownRegisterRefusal(
	held: HeldRegisterRefusal | undefined,
	moduleUuid: Uuid,
	revision: object,
): string | undefined {
	return held !== undefined &&
		held.moduleUuid === moduleUuid &&
		held.revision === revision
		? held.message
		: undefined;
}
