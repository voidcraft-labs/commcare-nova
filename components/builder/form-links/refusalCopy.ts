// components/builder/form-links/refusalCopy.ts
//
// Every refusal an author can meet on the after-submit surfaces, in words.
//
// The planners answer with a reason code and the links the answer is
// about; this turns that into a sentence. It must stay a projection: a
// refusal's wording may never imply a rule the planner does not enforce,
// because the author will act on the wording.
//
// The positional rules are two, and they are the same fact seen from each
// side: a link with a condition stays above the otherwise link, and the
// otherwise link stays last. The target rules keep a destination present,
// distinct from this form, outside any circular path, and able to receive the
// complete case selection.

import type { FormLinkCommitPlan } from "@/lib/doc/formLinkMutations";
import type {
	FormLinkAddChoices,
	FormLinkMoveVerdict,
	FormLinkTargetVerdict,
} from "@/lib/doc/formLinkReview";
import type { Uuid } from "@/lib/doc/types";
import { destinationPhrase } from "./afterSubmitCopy";

/** Why this position is not available. */
export function moveRefusalReason(
	verdict: Extract<FormLinkMoveVerdict, { ok: false }>,
): string {
	switch (verdict.reason) {
		case "after-else":
			return "A link with a condition has to stay above the otherwise link.";
		case "else-not-last":
			return "The otherwise link has to stay last: it only runs when nothing above it matched.";
	}
}

/** The same, for a verdict that may be available. */
export function moveRefusal(
	verdict: FormLinkMoveVerdict | undefined,
): string | undefined {
	return verdict === undefined || verdict.ok
		? undefined
		: moveRefusalReason(verdict);
}

/**
 * Why a destination cannot be chosen. `nameOf` resolves a form uuid for
 * the cycle chain; the chain runs from the would-be destination back to
 * this form, so its last entry is always "this form".
 */
export function targetRefusalReason(
	verdict: Extract<FormLinkTargetVerdict, { ok: false }>,
	nameOf: (formUuid: Uuid) => string | undefined,
): string {
	switch (verdict.reason) {
		case "target-not-found":
			return "That destination is no longer part of the app.";
		case "self-target":
			return "This form can't send the person straight back into itself.";
		case "selection-cardinality":
			return "This form can't carry its complete case selection there. Open the destination's form list so the person can choose again.";
		case "cycle": {
			const steps = verdict.chain.map((uuid, index) =>
				index === verdict.chain.length - 1
					? "this form"
					: `“${nameOf(uuid) ?? "another form"}”`,
			);
			return `Going there would lead back here: ${steps.join(" → ")}.`;
		}
	}
}

/** The same, for a verdict that may be available. */
export function targetRefusal(
	verdict: FormLinkTargetVerdict,
	nameOf: (formUuid: Uuid) => string | undefined,
): string | undefined {
	return verdict.ok ? undefined : targetRefusalReason(verdict, nameOf);
}

/** Why "Otherwise go somewhere else" is not on offer right now. */
export function otherwiseUnavailableReason(
	choices: FormLinkAddChoices,
): string | undefined {
	return choices.otherwise.ok
		? undefined
		: "This form already has an otherwise link. Change where it goes instead.";
}

/**
 * The inline question before a link is removed. A removal that pins the
 * fallback says so: the author is about to lose the otherwise link, and
 * the form will explicitly go somewhere they did not just choose.
 */
export function removalQuestion(
	lead: string,
	plan: FormLinkCommitPlan,
): string {
	const pinned =
		plan.ok && plan.pinsFallback !== undefined
			? ` When nothing above matches, the form will then go ${destinationPhrase(plan.pinsFallback)}.`
			: "";
	return `Remove “${lead}”?${pinned} You can undo this.`;
}

/** Why a conditional link cannot become the otherwise link right now. */
export function makeOtherwiseUnavailableReason(args: {
	readonly isLast: boolean;
	readonly hasElse: boolean;
}): string | undefined {
	if (args.hasElse) {
		return "This form already has an otherwise link. Remove it first, or change where it goes.";
	}
	if (!args.isLast) {
		return "Only the last link can be the otherwise link. Move this one to the bottom first.";
	}
	return undefined;
}
