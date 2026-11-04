// components/builder/form-links/refusalCopy.ts
//
// Every refusal an author can meet on the after-submit surfaces, in words.
//
// The planners answer with a reason code and the links the answer is
// about; this turns that into a sentence. It must stay a projection: a
// refusal's wording may never imply a rule the planner does not enforce,
// because the author will act on the wording.
//
// Destinations run in the author's order at any position, so no position is
// ever refused. The target rules keep a destination present, spelled
// `this-form` when it starts this form again, a menu CommCare HQ offers from
// this form's menu, and able to receive the complete case selection. The
// Otherwise exists only while some destination may not run.

import type {
	FormLinkCommitPlan,
	FormLinkRefusal,
} from "@/lib/doc/formLinkMutations";
import type {
	FormLinkAddChoices,
	FormLinkTargetVerdict,
} from "@/lib/doc/formLinkReview";
import type { Uuid } from "@/lib/doc/types";
import { destinationLabel } from "./afterSubmitCopy";

/** Why "Otherwise, go somewhere else" or an Otherwise can't be set now. */
export const OTHERWISE_UNREACHABLE_REASON =
	"Give a destination a condition first, so there is a time when none runs.";

/** Why "Make this a destination" has nothing to work on. */
export const NO_OTHERWISE_LINK_REASON =
	"This form's Otherwise isn't a link, so there's no destination to make from it.";

/** Why a submenu is not on offer from this form's menu. `parentName` is
 *  the menu that holds it, which a link may open instead. */
export function submenuNotOfferedReason(
	parentName: string | undefined,
): string {
	return parentName === undefined
		? "CommCare HQ can't link to this submenu from here. You can choose a form inside it."
		: `CommCare HQ can't link to this submenu from here. You can choose ${parentName} or a form inside it.`;
}

/** Why a destination cannot be chosen. `menuNameOf` names the menu that
 *  holds a submenu CommCare HQ does not offer from here. */
export function targetRefusalReason(
	verdict: Extract<FormLinkTargetVerdict, { ok: false }>,
	menuNameOf: (moduleUuid: Uuid) => string | undefined,
): string {
	switch (verdict.reason) {
		case "target-not-found":
			return "That destination is no longer part of the app.";
		case "self-target":
			return "A link can't name this form by itself. You can choose Start this form again instead.";
		case "not-offered":
			return submenuNotOfferedReason(
				verdict.parentUuid === undefined
					? undefined
					: menuNameOf(verdict.parentUuid),
			);
		case "selection-cardinality":
			return "This form can't carry its complete case selection there. Open the destination's form list so the person can choose again.";
		case "selection-case-type":
			return `This form can change the selected cases' type before they get there. Open the destination's form list so the person can choose matching cases, or keep every selected case as “${verdict.expectedCaseType}”.`;
	}
}

/** The same, for a verdict that may be available. */
export function targetRefusal(
	verdict: FormLinkTargetVerdict,
	menuNameOf: (moduleUuid: Uuid) => string | undefined,
): string | undefined {
	return verdict.ok ? undefined : targetRefusalReason(verdict, menuNameOf);
}

/**
 * Every planner refusal (`FormLinkRefusal`) as the builder says it: what
 * went wrong and what the person can do next. `menuNameOf` names a menu;
 * `parentName` of a built-in Otherwise is the form's parent menu.
 */
export function formLinkRefusalReason(
	reason: FormLinkRefusal,
	menuNameOf: (moduleUuid: Uuid) => string | undefined,
	parentName?: string,
): string {
	switch (reason.kind) {
		case "form-not-found":
			return "This form is no longer part of the app.";
		case "link-not-found":
			return "This destination is no longer part of the form. Review the latest list and try again.";
		case "duplicate-uuid":
			return "This destination was added elsewhere first. Review the latest list and try again.";
		case "stale-base":
			return "This destination was changed elsewhere first. Review the latest list and try again.";
		case "target-not-found":
			return "That form or module is no longer part of the app. You can choose another one.";
		case "self-target":
			return "A link can't name this form by itself. You can choose Start this form again instead.";
		case "target-not-offered":
			return submenuNotOfferedReason(
				reason.parentUuid === undefined
					? undefined
					: menuNameOf(reason.parentUuid),
			);
		case "menu-carries-values":
			return "A module's form list asks for no values. You can remove the carried values, or send the link to a form inside it.";
		case "selection-cardinality":
			return "That form chooses cases differently from this one, so the link can't hand its cases on. You can choose another destination.";
		case "otherwise-unreachable":
			return OTHERWISE_UNREACHABLE_REASON;
		case "otherwise-not-offered":
			return `This form's menu doesn't offer ${destinationLabel(reason.destination, parentName)} after submit. You can choose another one.`;
		case "otherwise-exists":
			return "This form already has an Otherwise. You can change it instead.";
		case "no-otherwise-link":
			return NO_OTHERWISE_LINK_REASON;
	}
}

/** Why "Otherwise, go somewhere else" is not on offer right now. */
export function otherwiseUnavailableReason(
	choices: FormLinkAddChoices,
): string | undefined {
	if (choices.otherwise.ok) return undefined;
	return choices.otherwise.reason === "otherwise-exists"
		? "This form already has an Otherwise. You can change it in the last row."
		: OTHERWISE_UNREACHABLE_REASON;
}

/** Why a planned action is withheld: the refusal's sentence, or nothing
 *  when the plan is admitted. */
export function planRefusal(
	plan: FormLinkCommitPlan,
	menuNameOf: (moduleUuid: Uuid) => string | undefined,
): string | undefined {
	return plan.ok ? undefined : formLinkRefusalReason(plan.reason, menuNameOf);
}

/**
 * The inline question before a destination is removed. A removal that
 * changes the Otherwise says so before it commits.
 */
export function removalQuestion(
	lead: string,
	plan: FormLinkCommitPlan,
): string {
	const consequence = !plan.ok
		? ""
		: plan.otherwiseToPostSubmit !== undefined ||
				plan.otherwiseToDestination !== undefined
			? " This form's Otherwise then becomes where it goes after submit."
			: plan.droppedOtherwise !== undefined
				? " This form's Otherwise then goes too, because every destination left runs each time."
				: "";
	return `Remove “${lead}”?${consequence} You can undo this.`;
}
