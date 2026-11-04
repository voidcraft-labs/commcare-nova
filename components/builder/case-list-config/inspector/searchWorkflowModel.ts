// components/builder/case-list-config/inspector/searchWorkflowModel.ts
//
// The pure model of When this menu opens (`SearchWorkflowSetting`): the three
// choices over `caseSearchConfig.workflow`, the Forms read the search switch
// over `formsReadSearch`, the batch each one commits, and why each is
// withheld. A platform the app runs on that can't run a choice withholds it
// with that platform's picker line first; otherwise the gate's own sentence
// for the choice's exact batch withholds it. Nothing here reads React.

import {
	formsReadSearchOffMutations,
	formsReadSearchOnMutations,
} from "@/lib/doc/caseListRegistrationForm";
import type { BlueprintDoc, Mutation } from "@/lib/doc/types";
import type { SearchWorkflow, Uuid } from "@/lib/domain";
import {
	type Platform,
	type PlatformFeatureId,
	platformPickerLine,
	platformRefusal,
} from "@/lib/domain/platforms";

type UpdateModuleMutation = Extract<Mutation, { kind: "updateModule" }>;
export type SearchWorkflowPatch = NonNullable<
	UpdateModuleMutation["caseSearchConfigPatch"]
>;

export interface SearchWorkflowChoice {
	readonly workflow: SearchWorkflow;
	readonly label: string;
	readonly line: string;
	/** The platform feature this choice is; its refusal and its note. */
	readonly feature: PlatformFeatureId;
}

/** The three choices, in the order the fieldset shows them. */
export const SEARCH_WORKFLOW_CHOICES: readonly SearchWorkflowChoice[] = [
	{
		workflow: "searchFirst",
		label: "Search first",
		line: "Workers search before they see any cases, and Results shows what the search finds",
		feature: "search-first",
	},
	{
		workflow: "skipToResults",
		label: "Results first",
		line: "Workers see the cases the search finds with its starting values, and can search again to narrow them",
		feature: "skip-to-results",
	},
	{
		workflow: "listFirst",
		label: "Case list first",
		line: "Workers see their cases and can search from the list",
		feature: "list-first",
	},
];

export const SEARCH_WORKFLOW_LEGEND = "When this menu opens";
export const FORMS_READ_SEARCH_LABEL = "Forms read the search";
export const FORMS_READ_SEARCH_LINE =
	"Each form runs the search as it opens, so it can read what was searched for and what was found";

/**
 * The patch a choice writes: absent is search first, so choosing it clears
 * the stored value; a menu that opens on its case list can't have its forms
 * read the search (`FORMS_READ_SEARCH_WITH_LIST_FIRST`), so Case list first
 * clears `formsReadSearch` in the same patch.
 */
export function searchWorkflowPatch(
	workflow: SearchWorkflow,
): SearchWorkflowPatch {
	switch (workflow) {
		case "searchFirst":
			return { workflow: null };
		case "skipToResults":
			return { workflow: "skipToResults" };
		case "listFirst":
			return { workflow: "listFirst", formsReadSearch: null };
	}
}

/** The one mutation a choice commits. */
export function searchWorkflowMutations(
	moduleUuid: Uuid,
	workflow: SearchWorkflow,
): Mutation[] {
	return [
		{
			kind: "updateModule",
			uuid: moduleUuid,
			patch: {},
			caseSearchConfigPatch: searchWorkflowPatch(workflow),
		},
	];
}

/** The batch the switch commits: Forms read the search on or off, through
 *  the planners every editor shares. Empty where it is already so. */
export function formsReadSearchMutations(
	doc: BlueprintDoc,
	moduleUuid: Uuid,
	on: boolean,
): Mutation[] {
	return on
		? formsReadSearchOnMutations(doc, moduleUuid)
		: formsReadSearchOffMutations(doc, moduleUuid);
}

/** The switch sits under Search first and Results first only. */
export function formsReadSearchOffered(workflow: SearchWorkflow): boolean {
	return workflow !== "listFirst";
}

/** The Android note under a choice: Search first and Results first each
 *  state how a phone opens the menu; Case list first has none. */
export function searchWorkflowNoteFeature(
	workflow: SearchWorkflow,
): PlatformFeatureId | undefined {
	return workflow === "listFirst"
		? undefined
		: SEARCH_WORKFLOW_CHOICES.find((choice) => choice.workflow === workflow)
				?.feature;
}

/**
 * Why a choice is withheld, or `undefined` when it is offered. The stored
 * choice is never withheld: it shows as it is. A platform the app runs on
 * that can't run it gives that platform's picker line; otherwise the gate's
 * sentence for its batch does.
 */
export function searchWorkflowChoiceRefusal(
	choice: SearchWorkflowChoice,
	current: SearchWorkflow,
	platforms: readonly Platform[],
	gateRefusal: string | undefined,
): string | undefined {
	if (choice.workflow === current) return undefined;
	const refusal = platformRefusal(choice.feature, platforms);
	return refusal === undefined ? gateRefusal : platformPickerLine(refusal);
}

/**
 * Why the switch is withheld, or `undefined` when it is offered. Turning it
 * off is withheld only by the gate (a form that reads the search keeps it on);
 * turning it on, by a platform that can't run it first, then by the gate.
 */
export function formsReadSearchRefusal(
	on: boolean,
	platforms: readonly Platform[],
	gateRefusal: string | undefined,
): string | undefined {
	if (on) return gateRefusal;
	const refusal = platformRefusal("forms-read-search", platforms);
	return refusal === undefined ? gateRefusal : platformPickerLine(refusal);
}

/**
 * What the Search canvas says about a Search screen a worker might not
 * fill in: a search first menu with no visible field shows the Search screen
 * with only its button; a results first
 * one opens on its cases. With a saved Search button condition and its forms
 * not reading the search, the condition decides whether the menu opens on
 * Search at all.
 */
export const BUTTON_ONLY_SEARCH_SCREEN_LINE =
	"Workers see a Search screen with only its Search button. Choose Results first to show the cases as the menu opens.";
export const RESULTS_ON_OPEN_LINE =
	"There's nothing to fill in. The menu opens on the cases the search finds, and Cases available decides what workers see.";
export const BUTTON_CONDITION_LINE =
	"While this condition is false, the menu opens on its case list.";
export const FORMS_READ_SEARCH_NO_BUTTON_LINE =
	"This menu's forms read the search, so there is no Search button to show or hide.";

/** The canvas sentences for one menu's search, in reading order. */
export function searchWorkflowCanvasLines({
	workflow,
	hasVisibleField,
	hasButtonCondition,
	formsReadSearch,
}: {
	readonly workflow: SearchWorkflow;
	readonly hasVisibleField: boolean;
	readonly hasButtonCondition: boolean;
	readonly formsReadSearch: boolean;
}): readonly string[] {
	if (workflow === "listFirst") return [];
	const lines: string[] = [];
	if (!hasVisibleField)
		lines.push(
			workflow === "searchFirst"
				? BUTTON_ONLY_SEARCH_SCREEN_LINE
				: RESULTS_ON_OPEN_LINE,
		);
	if (hasButtonCondition && !formsReadSearch) lines.push(BUTTON_CONDITION_LINE);
	return lines;
}
