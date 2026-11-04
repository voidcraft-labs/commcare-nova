// lib/domain/placementCopy.ts
//
// The words a person reads about where CommCare HQ keeps a case change:
// each ineligibility reason's sentence and each placement's line. Every
// switch is total over its union, so a reason or a placement arm without
// copy fails to compile.

import type { CasePlacement, PlacementIneligibilityReason } from "./placements";

/** Why a case change can no longer stay where it is, in one sentence. */
export function placementIneligibilitySentence(
	reason: PlacementIneligibilityReason,
): string {
	switch (reason) {
		case "module-advanced":
			return "Its menu is now an advanced menu in CommCare HQ, where every form saves its cases through case actions.";
		case "module-basic":
			return "Its menu is no longer an advanced menu in CommCare HQ.";
		case "several-cases":
			return "Its form now works on several cases at once, and Case Management saves one case per form.";
		case "value-computed":
			return "One of its values is now a calculation, which Case Management can't save.";
		case "value-label":
			return "One of its values now reads a label or a group, which Case Management can't save.";
		case "value-in-repeat":
			return "One of its values now comes from a question inside a repeat.";
		case "value-wrong-repeat":
			return "One of its values now comes from a question in another repeat than the one it runs in.";
		case "name-repeat":
			return "Its name now comes from a question in another repeat than the one it runs in.";
		case "write-condition":
			return "One of its saves now has a condition of its own, which Case Management can't hold.";
		case "links":
			return "It now links to another case, which Case Management can't do for this form's case.";
		case "subcase-link":
			return "Its link changed, and Case Management creates a new case only as a child of this form's case.";
		case "own-not-basic":
			return "This form's own case is now saved through Save to Case, and Case Management links a new case only to a case it saves itself.";
		case "subcase-type":
			return "Its case type is no longer one a menu of this app uses.";
		case "keyed-id":
			return "Its case id now comes from an answer.";
		case "condition-shape":
			return "Its condition is now more than one question compared with one value.";
		case "condition-question-kind":
			return "Its condition now reads a question that isn't a select, a hidden value or a label.";
		case "condition-question-repeat":
			return "Its condition now reads a question inside a repeat it doesn't run in.";
		case "condition-apostrophe":
			return "Its condition now compares with a value that holds an apostrophe.";
		case "condition-quote-boundary":
			return "Its condition now compares with a value that starts or ends with a double quote.";
		case "condition-not-a-choice":
			return "Its condition now compares a select with a value that isn't one of its choices.";
		case "case-changed-before-create":
			return "Another case change now updates or closes the case it creates, and Case Management would create that case only after it.";
		case "subcase-index":
			return "A new case before it was removed or moved, so its place in Case Management's list of new cases changed.";
		case "subcase-nesting":
			return "The repeat it runs in now creates a different number of new cases, so Case Management keeps it in a new place.";
		case "only-if-changed":
			return "One of its saves now keeps only changed answers, which Save to Case can't do.";
		case "via":
			return "One of its saves now goes to a case above it, which Save to Case can't do in the same block.";
		case "scope":
			return "It now runs in another repeat.";
		case "block-shape":
			return "Its condition, or the answer its case id comes from, changed, which changes where Save to Case keeps it.";
		case "no-close":
			return "This form no longer closes its case.";
		default: {
			const _exhaustive: never = reason;
			return _exhaustive;
		}
	}
}

/** Where CommCare HQ keeps a case change, in one line. */
export function placementLine(placement: CasePlacement): string {
	switch (placement.kind) {
		case "basic":
			return "CommCare HQ keeps this in the form's Case Management settings.";
		case "save-to-case":
			return "CommCare HQ keeps this in a Save to Case block in the form, which needs Save to Case in the project space's plan.";
		default: {
			const _exhaustive: never = placement;
			return _exhaustive;
		}
	}
}
