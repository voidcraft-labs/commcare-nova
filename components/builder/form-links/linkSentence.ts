// components/builder/form-links/linkSentence.ts
//
// How one after-submit link reads to a person.
//
// A DISPLAY PROJECTION and nothing else, the same discipline as the
// case-operation sentence: the destination, the condition, and whether it
// carries values are read straight off the stored link, and the legality
// of every one of them is decided by the validator and the planners. If
// this file ever seems to know something the link does not say, that is
// the bug.
//
// The vocabulary is intent-level. CommCare calls this a "form link" with
// an "end-of-form navigation" stack; an author is told where the person
// GOES ("Go to “Visit”", "Open the “Care” form list").

import type { FormLink, FormLinkTarget } from "@/lib/domain";

/** What a sentence needs from outside the link to read naturally. */
export interface LinkSentenceContext {
	/** The destination a target names, or `undefined` once it is gone. */
	readonly destinationOf: (
		target: FormLinkTarget,
	) => { readonly kind: "form" | "module"; readonly name: string } | undefined;
	/** The printed text of a link's condition; `""` when it has none. */
	readonly conditionText: (link: FormLink) => string;
}

export interface LinkSentence {
	/** The lead clause: where the person goes. */
	readonly lead: string;
	/** Qualifying clauses in reading order: when, then what travels. */
	readonly details: readonly string[];
}

/** The lead clause for a target, without the rest of the link. */
export function linkLead(
	target: FormLinkTarget,
	context: Pick<LinkSentenceContext, "destinationOf">,
): string {
	const destination = context.destinationOf(target);
	if (destination === undefined) {
		return target.type === "form"
			? "Go to a form that is no longer in the app"
			: "Open a form list that is no longer in the app";
	}
	return destination.kind === "form"
		? `Go to “${destination.name}”`
		: `Open the “${destination.name}” form list`;
}

export function linkSentence(
	link: FormLink,
	context: LinkSentenceContext,
): LinkSentence {
	const details: string[] = [];
	const condition = context.conditionText(link).trim();
	if (condition.length > 0) details.push(`When ${condition}`);
	const carried = link.datums?.length ?? 0;
	if (carried > 0) {
		details.push(
			carried === 1
				? "Carries 1 value worked out here"
				: `Carries ${carried} values worked out here`,
		);
	}
	return { lead: linkLead(link.target, context), details };
}

/**
 * The whole row as one string, for an accessible name and for any
 * surface that needs the sentence without the row's layout.
 */
export function linkSentenceText(sentence: LinkSentence): string {
	return sentence.details.length === 0
		? sentence.lead
		: `${sentence.lead}: ${sentence.details.join(", ")}`;
}
