// components/builder/form-links/linkSentence.ts
//
// How one after-submit link reads to a person.
//
// A DISPLAY PROJECTION and nothing else, the same discipline as the
// case-operation sentence: the destination, the condition, and whether it
// carries a case are read straight off the stored link and the document,
// and the legality of every one of them is decided by the validator and the
// planners. If this file ever seems to know something the link does not
// say, that is the bug.
//
// The vocabulary is intent-level. CommCare calls this a "form link" with
// an "end-of-form navigation" stack; an author is told where the person
// GOES ("Go to “Visit”", "Open the “Care” form list", "Start this form
// again") and when ("Every time", "When …").

import type { FormLink, FormLinkDatum, FormLinkTarget } from "@/lib/domain";

/** A link as a sentence reads it: a destination, or the otherwise link,
 *  which has no condition. */
export type SentenceLink = Pick<FormLink, "uuid" | "target"> & {
	readonly datums?: readonly FormLinkDatum[];
	readonly condition?: FormLink["condition"];
};

/** What a sentence needs from outside the link to read naturally. */
export interface LinkSentenceContext {
	/** The destination a target names, or `undefined` once it is gone. */
	readonly destinationOf: (target: FormLinkTarget) =>
		| {
				readonly kind: "form" | "module" | "this-form";
				readonly name: string;
		  }
		| undefined;
	/** The printed text of a link's condition; `""` when it has none. */
	readonly conditionText: (link: SentenceLink) => string;
	/** Whether the link carries a case onto a single-case selection, so it
	 *  runs only while that case is on the worker's device
	 *  (`afterSubmit.ts::guardedLinkDatums`). */
	readonly carriesHeldCase: (link: SentenceLink) => boolean;
}

export interface LinkSentence {
	/** The lead clause: where the person goes. */
	readonly lead: string;
	/** Qualifying clauses in reading order: when, then what travels. */
	readonly details: readonly string[];
}

/** The line a destination with no condition reads. */
export const EVERY_TIME_LINE = "Every time";

/** The line a destination that carries a case adds. */
export const HELD_CASE_LINE =
	"When the case it carries is on the worker's device";

/** The lead clause for a target, without the rest of the link. */
export function linkLead(
	target: FormLinkTarget,
	context: Pick<LinkSentenceContext, "destinationOf">,
): string {
	if (target.type === "this-form") return "Start this form again";
	const destination = context.destinationOf(target);
	if (destination === undefined) {
		return target.type === "form"
			? "Go to a form that is no longer in the app"
			: "Open a form list that is no longer in the app";
	}
	return destination.kind === "module"
		? `Open the “${destination.name}” form list`
		: `Go to “${destination.name}”`;
}

/**
 * One link as a row reads it. A destination says when it runs: "When
 * <condition>", the held-case line when it carries a case, and "Every time"
 * only when neither holds, since a destination that carries a case does not
 * run when the case is missing. The otherwise link has no "when" of its
 * own: its row says that.
 */
export function linkSentence(
	link: SentenceLink,
	context: LinkSentenceContext,
	role: "destination" | "otherwise" = "destination",
): LinkSentence {
	const details: string[] = [];
	const condition = context.conditionText(link).trim();
	const held = context.carriesHeldCase(link);
	if (role === "destination") {
		if (condition.length > 0) details.push(`When ${condition}`);
		else if (!held) details.push(EVERY_TIME_LINE);
	}
	if (held) details.push(HELD_CASE_LINE);
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
