// components/builder/form-links/afterSubmitCopy.ts
//
// Every sentence the after-submit surfaces share, in one place: the
// settings row, the workspace's otherwise row, the chooser, the
// announcements and the toasts all describe the same five built-in
// destinations and the same Otherwise, and a second spelling of any of them is how one
// surface ends up contradicting another.
//
// Display projections, and the one toast that speaks a commit's reports.
// Nothing here decides what a form does; the planners in
// `lib/doc/formLinkMutations.ts` do, and these words describe their answers.

import type { AfterSubmitPlan } from "@/lib/doc/formLinkMutations";
import type { FormLinkTargetVisibility } from "@/lib/doc/hooks/useFormLinkFacts";
import type { FormLinkWriteReports } from "@/lib/doc/hooks/useFormLinks";
import type {
	FormLinkTarget,
	FormOtherwise,
	PostSubmitDestination,
} from "@/lib/domain";
import type { Platform } from "@/lib/domain/platforms";
import { showToast } from "@/lib/ui/toastStore";

/** Where the person goes, as a prepositional phrase: "goes {phrase}". */
export function destinationPhrase(destination: PostSubmitDestination): string {
	switch (destination) {
		case "app_home":
			return "to the app home";
		case "firstMenu":
			return "to the app's first menu";
		case "module":
			return "to this module's form list";
		case "parentMenu":
			return "to the parent module";
		case "previous":
			return "back to the previous screen";
	}
}

/**
 * The destination as a standalone label: a chooser item, a trigger. The
 * parent module's label names the parent where the caller knows it.
 */
export function destinationLabel(
	destination: PostSubmitDestination,
	parentName?: string,
): string {
	switch (destination) {
		case "app_home":
			return "App home";
		case "firstMenu":
			return "First menu";
		case "module":
			return "This module";
		case "parentMenu":
			return parentName === undefined
				? "Parent module"
				: `Parent module: ${parentName}`;
		case "previous":
			return "Previous screen";
	}
}

/** The one-line detail under a chooser item. */
export function destinationDetail(destination: PostSubmitDestination): string {
	switch (destination) {
		case "app_home":
			return "Back to the main screen";
		case "firstMenu":
			return FIRST_MENU_HELP;
		case "module":
			return "Stay in this module's form list";
		case "parentMenu":
			return "Back to the parent module, with its selection kept";
		case "previous":
			return "Back to where the person was";
	}
}

/**
 * What First menu means, beside App home. On Android the two open different
 * screens; that difference is the `after-submit-home` note row under the
 * chooser, read from the platform table.
 */
export const FIRST_MENU_HELP =
	"Opens the app's first menu, which lists its modules";

/** One sentence per platform the app runs on, Android's clause first; for
 *  both platforms, the two joined as one sentence. */
function perPlatform(
	platforms: readonly Platform[],
	lead: string,
	android: string,
	webApps: string,
): string {
	const onAndroid = platforms.includes("android");
	const inWebApps = platforms.includes("web-apps");
	if (onAndroid && inWebApps) return `${lead}${android}, and ${webApps}.`;
	return onAndroid ? `${lead}${android}.` : `${lead}${webApps}.`;
}

/**
 * The line under a link whose target some worker may not see on the menu,
 * from `formLinkTargetVisibility`: what each platform the app runs on does
 * when that worker submits. `insideHiddenModule` says a target form is off
 * the menu because the module that holds it is. Nothing for a target
 * nothing hides.
 */
export function hiddenTargetLine(
	visibility: FormLinkTargetVisibility | undefined,
	insideHiddenModule: boolean,
	platforms: readonly Platform[],
): string | undefined {
	if (visibility?.hiddenBy === undefined) return undefined;
	if (visibility.hiddenBy === "condition") {
		return visibility.targetKind === "form"
			? perPlatform(
					platforms,
					"When this form's display condition is false for a worker, ",
					"Android still opens it after submit",
					"Web Apps opens the module that holds it instead",
				)
			: perPlatform(
					platforms,
					"When this module's display condition is false for a worker, ",
					"Android opens it with nothing in it",
					"Web Apps opens the app's first screen instead",
				);
	}
	if (visibility.targetKind === "module") return undefined;
	return insideHiddenModule
		? perPlatform(
				platforms,
				"This form's module is off the menu. ",
				"Android still opens the form after submit",
				"Web Apps opens the app's first screen instead",
			)
		: perPlatform(
				platforms,
				"This form is off the menu. ",
				"Android still opens it after submit",
				"Web Apps opens the module that holds it instead",
			);
}

/** The chooser item that points somewhere a built-in destination does not. */
export const OTHER_TARGET_CHOICE_LABEL = "Another form or module";

/** The otherwise chooser's item for no otherwise: the app home follows. */
export const APP_HOME_CHOICE_LABEL = "The app home";

/** Names a link target for a sentence; `undefined` once it is gone. */
export type TargetNameOf = (target: FormLinkTarget) =>
	| {
			readonly kind: "form" | "module" | "this-form";
			readonly name: string;
	  }
	| undefined;

/** "“Visit”" / "the “Care” form list" / "this form again": what a link
 *  opens, as the object of "Opens" or "to". */
function targetObject(target: FormLinkTarget, nameOf: TargetNameOf): string {
	if (target.type === "this-form") return "this form again";
	const destination = nameOf(target);
	if (destination === undefined)
		return "a destination that is no longer in the app";
	return destination.kind === "module"
		? `the “${destination.name}” form list`
		: `“${destination.name}”`;
}

/**
 * Where the form goes when no destination that may not run runs, as the
 * phrase after "Otherwise,": an absent otherwise is the app home.
 */
export function otherwisePhrase(
	otherwise: FormOtherwise | undefined,
	nameOf: TargetNameOf,
): string {
	if (otherwise === undefined) return "back to the app home";
	if (otherwise.kind === "destination") {
		return destinationPhrase(otherwise.destination);
	}
	return `to ${targetObject(otherwise.target, nameOf)}`;
}

/** The otherwise as one sentence: "Otherwise, back to the app home". */
export function otherwiseSentence(
	otherwise: FormOtherwise | undefined,
	nameOf: TargetNameOf,
): string {
	return `Otherwise, ${otherwisePhrase(otherwise, nameOf)}`;
}

/** Whether some destination runs every time: no condition and no carried
 *  case, so it is not among the destinations that may not run. */
export function hasEveryTimeDestination(plan: AfterSubmitPlan): boolean {
	return plan.destinations.some(
		(link) => !plan.mayNotRun.some((candidate) => candidate.uuid === link.uuid),
	);
}

/**
 * The line under the otherwise row: when it runs, and, while some
 * destination runs every time, that the otherwise opens before it (CommCare
 * HQ pushes the otherwise's frame last, so it is on top).
 */
export function otherwiseSubtitle(everyTimeDestinationExists: boolean): string {
	const when = "When no destination with a condition or a carried case runs.";
	return everyTimeDestinationExists
		? `${when} It opens before any destination that runs every time.`
		: when;
}

/** Where a form without destinations goes: "After submit, the form goes
 *  to the app home". */
export function postSubmitSentence(destination: PostSubmitDestination): string {
	return `After submit, the form goes ${destinationPhrase(destination)}`;
}

/** The form-settings row's description of what submitting this form does. */
export interface AfterSubmitSummary {
	/** "Goes to …", "Opens …" or "Runs n destinations in order". */
	readonly lead: string;
	/** "Otherwise, …", while the form may hold an otherwise or holds one. */
	readonly otherwise: string | undefined;
}

export function afterSubmitSummary(
	plan: AfterSubmitPlan,
	nameOf: TargetNameOf,
): AfterSubmitSummary {
	const count = plan.destinations.length;
	const only = plan.destinations[0];
	const lead =
		plan.postSubmit !== undefined || only === undefined
			? `Goes ${destinationPhrase(plan.postSubmit?.destination ?? "app_home")}`
			: count === 1
				? `Opens ${targetObject(only.target, nameOf)}`
				: `Runs ${count} destinations in order`;
	return {
		lead,
		otherwise:
			count > 0 && (plan.otherwise !== undefined || plan.otherwiseOffered)
				? otherwiseSentence(plan.otherwise, nameOf)
				: undefined,
	};
}

/** The announcement after the otherwise changes. */
export function otherwiseChangedAnnouncement(
	next: FormOtherwise | null,
	nameOf: TargetNameOf,
): string {
	return `Otherwise now goes ${otherwisePhrase(next ?? undefined, nameOf)}.`;
}

/** The announcement after a form without destinations changes where it goes. */
export function postSubmitChangedAnnouncement(
	next: PostSubmitDestination,
): string {
	return `After submit, this form now goes ${destinationPhrase(next)}.`;
}

/**
 * What a committed batch also did, one sentence each, from the planner's
 * reports (`FormLinkCommitPlan`), for the toast that follows the commit.
 */
export function commitReportSentences(reports: FormLinkWriteReports): string[] {
	const sentences: string[] = [];
	if (reports.movedToOtherwise !== undefined) {
		sentences.push("Where this form went after submit is now its Otherwise.");
	}
	if (reports.droppedPostSubmit !== undefined) {
		sentences.push(
			`This form no longer goes ${destinationPhrase(reports.droppedPostSubmit)} after submit, because its destinations say where it goes now.`,
		);
	}
	if (reports.droppedOtherwise !== undefined) {
		sentences.push(
			"This form's Otherwise is gone, because every destination now runs each time.",
		);
	}
	if (
		reports.otherwiseToPostSubmit !== undefined ||
		reports.otherwiseToDestination !== undefined
	) {
		sentences.push("This form's Otherwise is now where it goes after submit.");
	}
	if ((reports.droppedDatums?.length ?? 0) > 0) {
		sentences.push(
			"The values it carried were removed, because the new destination doesn't read them.",
		);
	}
	return sentences;
}

/** What a carried value's editor is seeded with. */
export const CARRIED_VALUE_HINT =
	"Give the case id the destination should open";

/** What a carried value's editor refuses an empty draft with. */
export const EMPTY_CARRIED_VALUE_REFUSAL =
	"A carried value needs an expression. Give the case id the destination should open, or carry it automatically instead.";

/** Why a several-case selection has no manual carried-value mode. */
export const SEVERAL_CASES_CARRY_AUTOMATICALLY =
	"This link carries the selected cases automatically. They travel together, so there's no separate value to enter for each case.";

/** Recovery copy for a stale explicit map on a several-case link. */
export const SEVERAL_CASES_MANUAL_CARRY_NEEDS_REPAIR =
	"This link has separate values for selected cases that have to travel together. Carrying them automatically repairs the link.";

/** Recovery copy when neither automatic nor explicit carry reaches a form. */
export const COMPLETE_SELECTION_NEEDS_FORM_LIST =
	"This form can't carry the complete case selection directly there. The destination's form list lets the person choose matching cases instead.";

/** Why nothing needs carrying to this destination. */
export function nothingNeededCopy(targetType: FormLinkTarget["type"]): string {
	return targetType === "module"
		? "This destination needs nothing carried: the person picks a case when they arrive."
		: "This destination needs nothing carried: it opens straight away.";
}

/**
 * What travels automatically, named by the source datum the projector
 * matched: the case this form opened (`case_id`), or the case it creates
 * (`case_id_new_*`).
 */
export function carriedAutomaticallyDetail(sourceDatumId: string): string {
	if (sourceDatumId === "case_id") {
		return "The case this form opened travels with the person.";
	}
	if (sourceDatumId.startsWith("case_id_new")) {
		return "The case this form creates travels with the person.";
	}
	return `The “${sourceDatumId}” selection travels with the person.`;
}

/** Tell the person what a committed batch also did, as one toast. Nothing
 *  shows when the batch did only what was asked. */
export function showCommitReportToast(reports: FormLinkWriteReports): void {
	const sentences = commitReportSentences(reports);
	if (sentences.length > 0) showToast("info", sentences.join(" "));
}
