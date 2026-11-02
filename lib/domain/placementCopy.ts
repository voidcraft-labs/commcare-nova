// lib/domain/placementCopy.ts
//
// The words a person reads about where CommCare HQ keeps a case change:
// each ineligibility reason's sentence, each placement's line, and the
// short name of each place a change can move between. Every switch is
// total over its union, so a reason, a placement arm or a label without
// copy fails to compile.

import type { AdvancedKindBlocker } from "./advancedModule";
import type { CasePlacement, PlacementIneligibilityReason } from "./placements";

/**
 * The places a held change can move between, named for a person: where
 * CommCare HQ keeps a case change, how a query repeat's rows are made, and
 * which kind of menu a module is. An identity move states its `from` and
 * `to` as two of these.
 */
export const PLACEMENT_LABELS = [
	"case-management",
	"case-actions",
	"save-to-case",
	"rows-set-when-opened",
	"rows-follow-query",
	"ordinary-menu",
	"advanced-menu",
] as const;
export type PlacementLabel = (typeof PLACEMENT_LABELS)[number];

/** A place's words, folded into a sentence ("from Case Management to Save
 *  to Case"). */
export function placementLabelWords(label: PlacementLabel): string {
	switch (label) {
		case "case-management":
			return "Case Management";
		case "case-actions":
			return "case actions";
		case "save-to-case":
			return "Save to Case";
		case "rows-set-when-opened":
			return "rows set when the form opens";
		case "rows-follow-query":
			return "rows that follow the cases found";
		case "ordinary-menu":
			return "an ordinary menu";
		case "advanced-menu":
			return "an advanced menu";
		default: {
			const _exhaustive: never = label;
			return _exhaustive;
		}
	}
}

/** Which place a case change's placement names. */
export function placementLabel(placement: CasePlacement): PlacementLabel {
	switch (placement.kind) {
		case "basic":
			return "case-management";
		case "advanced":
			return "case-actions";
		case "save-to-case":
			return "save-to-case";
		default: {
			const _exhaustive: never = placement;
			return _exhaustive;
		}
	}
}

/** What a line about a held placement adds: the change stays where the
 *  published app keeps it. */
export const HELD_PLACEMENT_SUFFIX = " · Kept where your published app has it";

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
			return "Another case change now updates or closes the case it creates, and CommCare HQ would create that case only after that change.";
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
		case "value-not-a-question":
			return "One of its values no longer comes straight from one question where it runs, which case actions can't save.";
		case "condition-not-stateable":
			return "Its condition is now more than case actions can state, which is one question compared with a value that holds no apostrophe.";
		case "via-on-indexed-load":
			return "One of its saves now goes to a case above it, which case actions can't do for a case chosen under its parent case.";
		case "owner":
			return "Its owner now comes from something other than one question's answer, which case actions can't save.";
		case "retype":
			return "It now changes the case's type, which case actions can't do.";
		case "link-target":
			return "It now links to a case that case actions can't link it to, since they link only a new case, and only to a case the form loads or creates before it.";
		case "link-renamed-load":
			return "It now links to a case chosen in the menu above, which case actions name differently there and can't link to.";
		case "repeat-shared":
			return "Its repeat now creates another case through case actions, which keep two new cases in one repeat apart only when both link to another case.";
		case "type-not-a-menu":
			return "Its case type is no longer one a menu of this app uses, and case actions create only cases of a menu's type.";
		case "keyed":
			return "Its case id now comes from an answer, and case actions give every new case a new id.";
		case "appended-name-taken":
			return "A question in the form now has the name CommCare HQ gives the place this change is saved.";
		case "worker-property-name":
			return "One of the worker properties it saves now has a name case actions can't save, which starts with a letter and holds only letters, digits, underscores and hyphens.";
		case "carried-create":
			return "An after-submit link now hands the case it creates to another form, which needs that case's id when the form opens.";
		default: {
			const _exhaustive: never = reason;
			return _exhaustive;
		}
	}
}

/**
 * Why a menu CommCare HQ holds as an advanced menu can no longer be one, in
 * one sentence: the reason of its `module-kind` move and of the gate's
 * `HELD_PLACEMENT_INEXPRESSIBLE` finding for it, the first blocker's kind.
 * `forms-read-search` is worded for the blocker as it reads today, a menu
 * that opens on its Search screen.
 */
export function advancedKindBlockerSentence(
	blocker: AdvancedKindBlocker["kind"],
): string {
	switch (blocker) {
		case "several-cases":
			return "It now lets workers choose several cases, which an advanced menu can't do.";
		case "forms-read-search":
			return "It now opens on its Search screen with its forms reading the search, which an advanced menu can't do.";
		case "case-list-menu-item-narrowed":
			return "Its case list in the menu now has a filter or a parent case, which an advanced menu would leave out.";
		case "chain-index":
			return "Its cases now link to their parent case under more than one name.";
		default: {
			const _exhaustive: never = blocker;
			return _exhaustive;
		}
	}
}

/** Where CommCare HQ keeps a case change, in one line. A held placement,
 *  one a published app already keeps, says so after the line. */
export function placementLine(placement: CasePlacement, held = false): string {
	const line = placementPlaceLine(placement);
	return held ? `${line}${HELD_PLACEMENT_SUFFIX}` : line;
}

function placementPlaceLine(placement: CasePlacement): string {
	switch (placement.kind) {
		case "basic":
			return "CommCare HQ keeps this in the form's Case Management settings.";
		case "advanced":
			return "CommCare HQ keeps this in the form's case actions.";
		case "save-to-case":
			return "CommCare HQ keeps this in a Save to Case block in the form, which needs Save to Case in the project space's plan.";
		default: {
			const _exhaustive: never = placement;
			return _exhaustive;
		}
	}
}
