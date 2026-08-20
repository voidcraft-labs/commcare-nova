// components/builder/form-links/afterSubmitCopy.ts
//
// Every sentence the after-submit surfaces share, in one place: the
// settings row, the workspace's terminal row, the chooser, and the
// announcements all describe the same three built-in destinations and the
// same "otherwise" idea, and a second spelling of any of them is how one
// surface ends up contradicting another.
//
// Display projections only. Nothing here decides what a form does; the
// planners in `lib/doc/formLinkMutations.ts` do, and these words describe
// their answers.

import type {
	AfterSubmitPlan,
	FallbackChoice,
} from "@/lib/doc/formLinkMutations";
import type { FormLinkTarget, PostSubmitDestination } from "@/lib/domain";

/** Where the person goes, as a prepositional phrase: "goes {phrase}". */
export function destinationPhrase(destination: PostSubmitDestination): string {
	switch (destination) {
		case "app_home":
			return "to the app home";
		case "module":
			return "to this module's form list";
		case "previous":
			return "back to the previous screen";
	}
}

/** The destination as a standalone label: a chooser item, a trigger. */
export function destinationLabel(destination: PostSubmitDestination): string {
	switch (destination) {
		case "app_home":
			return "App home";
		case "module":
			return "This module";
		case "previous":
			return "Previous screen";
	}
}

/** The one-line detail under a chooser item. */
export function destinationDetail(destination: PostSubmitDestination): string {
	switch (destination) {
		case "app_home":
			return "Back to the main screen";
		case "module":
			return "Stay in this module's form list";
		case "previous":
			return "Back to where the person was";
	}
}

/** The chooser's fourth item: a link instead of a built-in destination. */
export const ELSE_LINK_CHOICE_LABEL = "Another form or module";

/** "to “Visit”" / "to the “Care” form list": where an otherwise link goes. */
export function elseLinkPhrase(destination: {
	readonly kind: "form" | "module";
	readonly name: string;
}): string {
	return destination.kind === "form"
		? `to “${destination.name}”`
		: `to the “${destination.name}” form list`;
}

/**
 * Where the form goes when nothing matched, as the phrase after "goes".
 * `nameOf` resolves a link target to its destination; a target that no
 * longer exists reads as such rather than crashing the sentence.
 */
export function fallbackPhrase(
	plan: AfterSubmitPlan,
	nameOf: (
		target: FormLinkTarget,
	) => { readonly kind: "form" | "module"; readonly name: string } | undefined,
): string {
	if (plan.fallback.kind === "post-submit") {
		return destinationPhrase(plan.fallback.destination);
	}
	const destination = nameOf(plan.fallback.link.target);
	return destination === undefined
		? "to a destination that is no longer in the app"
		: elseLinkPhrase(destination);
}

/** The settings row's description: what submitting this form does next. */
export function afterSubmitSummary(
	plan: AfterSubmitPlan,
	nameOf: Parameters<typeof fallbackPhrase>[1],
): string {
	const phrase = fallbackPhrase(plan, nameOf);
	const count = plan.conditional.length;
	if (count === 0) {
		return `When this form is submitted, the person goes ${phrase}.`;
	}
	const links = count === 1 ? "1 link" : `${count} links`;
	return plan.elseLink === undefined
		? `This form checks ${links} first, and goes ${phrase} when none of them match.`
		: `This form checks ${links} first, and otherwise goes ${phrase}.`;
}

/** The announcement after a fallback commit. */
export function fallbackChangedAnnouncement(
	next: FallbackChoice,
	nameOf: Parameters<typeof fallbackPhrase>[1],
): string {
	if (typeof next === "string") {
		return `Otherwise now goes ${destinationPhrase(next)}.`;
	}
	const destination = nameOf(next.target);
	return destination === undefined
		? "Otherwise now goes to another form or module."
		: `Otherwise now goes ${elseLinkPhrase(destination)}.`;
}

/**
 * What a batch that pinned the fallback says. The planner stored the
 * form's current effective destination explicitly so the result passes
 * the gate; the author hears that it did.
 */
export function pinsFallbackSentence(
	destination: PostSubmitDestination,
): string {
	return `Otherwise now explicitly goes ${destinationPhrase(destination)}.`;
}

/** The inline question before a built-in destination replaces the otherwise link. */
export function stopElseLinkQuestion(
	elseName: string,
	next: PostSubmitDestination,
): string {
	return `Stop going to “${elseName}”? When nothing above matches, the form will go ${destinationPhrase(next)} instead. You can undo this.`;
}

/** The detail an empty condition is refused with. */
export const EMPTY_CONDITION_REFUSAL =
	"A link needs a condition. To send the form here whenever nothing else matched, make it the otherwise link in the panel.";

/** What a carried value's editor is seeded with. */
export const CARRIED_VALUE_HINT =
	"Give the case id the destination should open";

/** What a carried value's editor refuses an empty draft with. */
export const EMPTY_CARRIED_VALUE_REFUSAL =
	"A carried value needs an expression. Give the case id the destination should open, or carry it automatically instead.";

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
