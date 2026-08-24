// components/builder/conditions/displayConditionCopy.ts
//
// Every word the display-condition surfaces say, derived from the
// carrier alone. Pure and separately tested, because the hard part of
// this feature is not the editor: it is telling an author WHERE their
// condition takes effect, and that answer changes with the module's
// shape.
//
// CommCare checks a root module's condition on Home, a child module's
// condition on its parent menu, and a form's condition wherever the worker
// chooses that form. Those are different screens depending on placement and
// module shape:
//
//   - every form opens an existing case (case-first): the worker picks a
//     case first, so the form condition is checked afterwards, against
//     the chosen case, including the shortcut that skips the form list
//     when a module has only one form;
//   - any form starts a new case or collects a plain survey
//     (forms-first): the worker chooses the form BEFORE any case, so
//     there is no case to read.
//
// `lib/domain/forms.ts::isCaseFirstModule` is the same distinction the
// runtime makes; this module only puts it into words.

import type { CaseDataScope } from "@/components/builder/shared/editorSchemas";

export type DisplayConditionCarrier =
	| {
			readonly kind: "module";
			readonly moduleName: string;
			/** Present for the one supported child tier. Its condition is checked
			 * on this parent menu rather than on Home. */
			readonly parentModuleName?: string;
			/** A module with no forms is its case list, so it has no home tile
			 *  of its own to describe differently: the copy still holds. */
			readonly moduleIsBareCaseList: boolean;
	  }
	| {
			readonly kind: "form";
			readonly formName: string;
			readonly moduleName: string;
			/** `isCaseFirstModule`: every form in the module opens an
			 *  existing case, so a case is chosen before the form is. */
			readonly caseFirst: boolean;
			/** The module's case type, when it declares one. */
			readonly caseType: string | undefined;
			/** How many forms the module holds. One case-first form is
			 *  auto-opened after a case is picked, which the copy names. */
			readonly formCount: number;
	  };

export interface DisplayConditionCopy {
	/** Page heading. */
	readonly title: string;
	/** One sentence naming what a condition does to this item. */
	readonly lede: string;
	/** Where CommCare checks it, in the order the worker meets it. */
	readonly locus: readonly string[];
	/** What the condition may read at that point. */
	readonly scopeNote: string;
	/** Heading over the condition itself. */
	readonly sectionTitle: string;
	/** What the whole rule is called inside the condition editor. Lower
	 *  case by construction: the workbench folds it into "Editing …" and
	 *  "Back to …", so a Title Case phrase or a quoted name reads wrong
	 *  there. */
	readonly ruleRootLabel: string;
	/** The editor scope this slot runs in. */
	readonly caseDataScope: CaseDataScope;
	/** What "no condition" means, for the settings-panel summary. */
	readonly alwaysSummary: string;
	/** Settings-panel row copy. */
	readonly settingTitle: string;
	readonly settingDescription: string;
	readonly clearLabel: string;
	readonly clearTitle: string;
	readonly clearConsequence: string;
	readonly backLabel: string;
}

/**
 * The one sentence both carriers carry. A condition decides what a
 * screen OFFERS; it changes nothing about what the app carries or what
 * reaches the device. An author who reads it as "only these people can
 * see this data" would be wrong in a way that matters, so the surface
 * says so plainly rather than leaving it to be inferred.
 *
 * Stated as the always-true fact rather than by naming a bypass: the
 * relevancy-ignoring deep link exists in CommCare
 * (`respect-relevancy="false"`) but Nova does not author one today, and
 * a sentence that becomes false the moment that changes is worse than
 * one that never does.
 */
export const DISPLAY_CONDITION_NOT_A_PERMISSION =
	"A condition decides what a screen offers, not who may see the data behind it. The app still carries this item and everything it reads.";

const NO_CASE_SCOPE_NOTE =
	"No case has been chosen at that point, so the condition can use fixed values and information about the person signed in, not case information.";

function quoted(name: string): string {
	return `“${name}”`;
}

export function displayConditionCopy(
	carrier: DisplayConditionCarrier,
): DisplayConditionCopy {
	if (carrier.kind === "module") {
		const name = quoted(carrier.moduleName);
		const parentName =
			carrier.parentModuleName === undefined
				? undefined
				: quoted(carrier.parentModuleName);
		return {
			title: `When ${name} appears`,
			lede:
				parentName === undefined
					? `${name} is one of the modules on the app's home screen. A condition keeps it off that screen unless the condition matches.`
					: `${name} is a submenu inside ${parentName}. A condition keeps it out of that menu unless the condition matches.`,
			locus: [
				parentName === undefined
					? `CommCare checks this on the home screen, before anyone opens a module${carrier.moduleIsBareCaseList ? " or sees a case list" : ""}.`
					: `CommCare checks this inside ${parentName}, before anyone opens ${name}${carrier.moduleIsBareCaseList ? " or sees its case list" : ""}.`,
			],
			scopeNote: NO_CASE_SCOPE_NOTE,
			sectionTitle: `Show ${name} when`,
			ruleRootLabel: "this module's condition",
			caseDataScope: "global",
			alwaysSummary: `${name} always appears`,
			settingTitle: "When this module appears",
			settingDescription:
				parentName === undefined
					? "Keep this module off the home screen unless a condition matches"
					: `Keep this module out of ${parentName} unless a condition matches`,
			clearLabel: "Always show",
			clearTitle: "Always show this module?",
			clearConsequence:
				parentName === undefined
					? `The condition will be removed and ${name} will appear on the home screen for everyone. You can undo this change.`
					: `The condition will be removed and ${name} will appear in ${parentName} for everyone. You can undo this change.`,
			/* A bare case list has no module screen: it IS its case list:
			 * so Back lands there and must say so. */
			backLabel: carrier.moduleIsBareCaseList
				? "Back to case list"
				: "Back to module",
		};
	}

	const name = quoted(carrier.formName);
	const moduleName = quoted(carrier.moduleName);
	const caseWord = carrier.caseType ?? "case";
	const shared = {
		title: `When ${name} appears`,
		sectionTitle: `Show ${name} when`,
		ruleRootLabel: "this form's condition",
		alwaysSummary: `${name} always appears`,
		settingTitle: "When this form appears",
		settingDescription:
			"Keep this form out of the list unless a condition matches",
		clearLabel: "Always show",
		clearTitle: "Always show this form?",
		clearConsequence: `The condition will be removed and ${name} will be offered every time. You can undo this change.`,
		backLabel: "Back to form",
	} as const;

	if (!carrier.caseFirst) {
		return {
			...shared,
			lede: `${moduleName} shows its list of forms before anyone picks a case, so CommCare checks this on that list.`,
			locus: [
				`${moduleName} holds a form that starts a new case, so people choose a form first and pick a case afterwards. This condition decides whether ${name} is on that list.`,
			],
			scopeNote: NO_CASE_SCOPE_NOTE,
			caseDataScope: "global",
		};
	}

	const locus = [
		`Every form in ${moduleName} opens an existing ${caseWord}, so people pick the ${caseWord} first. CommCare checks this straight afterwards, for the ${caseWord} they picked.`,
	];
	if (carrier.formCount <= 1) {
		locus.push(
			`${name} is the only form here, so picking a ${caseWord} normally opens it immediately. A ${caseWord} this condition does not match stops at the list instead.`,
		);
	} else {
		locus.push(
			`It decides whether ${name} is one of the forms offered for that ${caseWord}.`,
		);
	}
	return {
		...shared,
		lede: `People reach ${name} by picking a ${caseWord} first, so CommCare checks this once that ${caseWord} is chosen.`,
		locus,
		scopeNote: `The chosen ${caseWord}'s own information is available here. Information from connected cases, and counts of them, is not. CommCare cannot reach them from this screen.`,
		caseDataScope: "selected-case",
	};
}
