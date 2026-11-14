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

import type { Platform } from "@/lib/domain/platforms";

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
			/** The module shows its forms in the menu above
			 *  (`Module.formsInMenuAbove`): its condition decides whether its
			 *  forms list there, and it has no tile of its own. */
			readonly formsInMenuAbove: boolean;
			/** The menu above as a sentence names it (`menuScreenCopy.ts::
			 *  menuAboveName`): the app's first menu, or the parent's name. A
			 *  submenu that keeps its screen under a parent that shows its forms
			 *  above lists on the app's first menu. */
			readonly aboveName: string;
	  }
	| {
			readonly kind: "form";
			readonly formName: string;
			readonly moduleName: string;
			/** The screen that lists the form chooses a case first
			 *  (`menuScreens.ts::screenChoosesCaseFirst`): every entry on it
			 *  opens the same existing case, so a case is chosen before the
			 *  form is. */
			readonly caseFirst: boolean;
			/** What keeps that screen forms first, where something does
			 *  (`menuScreens.ts::screenCaseFirstBlocker`), with the names its
			 *  sentence reads. */
			readonly caseFirstBlocker?: {
				readonly reason:
					| "first-menu"
					| "bare-case-list"
					| "opens-without-a-case"
					| "chooses-another-case";
				/** The menu holding what keeps the screen forms first, where it
				 *  is another menu than the form's own. */
				readonly otherModuleName?: string;
				readonly blockingFormName?: string;
			};
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
	/** What "no condition" means, for the settings-panel summary. */
	readonly alwaysSummary: string;
	/** The "Show on the menu" switch's label. */
	readonly menuSwitchLabel: string;
	/** What the switch says while the item is on the menu. */
	readonly onTheMenuNote: string;
	/** What the switch says once the item is off the menu: what still
	 *  opens it, on each platform the app runs on. */
	readonly offTheMenuNote: string;
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

/** The switch that takes a module or a form off the menu. */
export const MENU_SWITCH_LABEL = "Show on the menu";

/** The condition row's heading: the condition applies while the item is on
 *  the menu. */
export const SHOWN_ON_THE_MENU_TITLE = "When shown on the menu";

/** What still opens a form that is off the menu, on each platform the app
 *  runs on. For both platforms it says both, Android first. */
export function formOffTheMenuNote(platforms: readonly Platform[]): string {
	const android = platforms.includes("android");
	const webApps = platforms.includes("web-apps");
	if (android && webApps)
		return "Off the menu. On Android this form opens from an after-submit link or an entry point. In Web Apps it opens only from an entry point that ignores display conditions.";
	if (android)
		return "Off the menu. On Android this form opens from an after-submit link or an entry point.";
	return "Off the menu. In Web Apps this form opens only from an entry point that ignores display conditions.";
}

/** What still opens the forms of a module that is off the menu, on each
 *  platform the app runs on. */
function moduleFormsStillOpen(platforms: readonly Platform[]): string {
	const android = platforms.includes("android");
	const webApps = platforms.includes("web-apps");
	if (android && webApps)
		return "On Android its forms open from an after-submit link or an entry point. In Web Apps they open only from an entry point that ignores display conditions.";
	if (android)
		return "On Android its forms open from an after-submit link or an entry point.";
	return "In Web Apps its forms open only from an entry point that ignores display conditions.";
}

/** What the switch says once a module is off the menu: what still opens
 *  its forms, on each platform the app runs on. */
export function moduleOffTheMenuNote(platforms: readonly Platform[]): string {
	return `Off the menu, with every form in it. ${moduleFormsStillOpen(platforms)}`;
}

/** The same, for a module that shows its forms in the menu above: its
 *  forms are what is off that menu. */
export function menuAboveOffTheMenuNote(
	moduleName: string,
	aboveName: string,
	platforms: readonly Platform[],
): string {
	return `${moduleName}'s forms are off ${aboveName}. ${moduleFormsStillOpen(platforms)}`;
}

/** The app's first menu, as a sentence names the menu above. */
export const FIRST_MENU_NAME = "the app's first menu";

const NO_CASE_SCOPE_NOTE =
	"No case has been chosen at that point, so the condition can use fixed values and information about the person signed in, not case information.";

function quoted(name: string): string {
	return `“${name}”`;
}

export function displayConditionCopy(
	carrier: DisplayConditionCarrier,
	platforms: readonly Platform[],
): DisplayConditionCopy {
	if (carrier.kind === "module") {
		const name = quoted(carrier.moduleName);
		const parentName =
			carrier.parentModuleName === undefined
				? undefined
				: quoted(carrier.parentModuleName);
		const above =
			carrier.aboveName === FIRST_MENU_NAME
				? FIRST_MENU_NAME
				: quoted(carrier.aboveName);
		if (carrier.formsInMenuAbove) {
			const locus = [
				`CommCare checks this in ${above}.`,
				`While it's false, ${name}'s forms don't show there.`,
			];
			if (parentName !== undefined)
				locus.push(`${parentName}'s condition applies to them too.`);
			return {
				title: `When ${name}'s forms appear`,
				lede: `${name} shows its forms in ${above}. A condition keeps them off that screen unless the condition matches.`,
				locus,
				scopeNote: NO_CASE_SCOPE_NOTE,
				sectionTitle: `Show ${name}'s forms when`,
				ruleRootLabel: "this module's condition",
				alwaysSummary: `${name}'s forms always appear`,
				menuSwitchLabel: MENU_SWITCH_LABEL,
				onTheMenuNote: `Workers find this module's forms in ${above}.`,
				offTheMenuNote: menuAboveOffTheMenuNote(name, above, platforms),
				settingTitle: SHOWN_ON_THE_MENU_TITLE,
				settingDescription: `Keep this module's forms out of ${above} unless a condition matches`,
				clearLabel: "Always show",
				clearTitle: "Always show this module's forms?",
				clearConsequence: `The condition will be removed and ${name}'s forms will appear in ${above} for everyone. You can undo this change.`,
				backLabel: "Back to module",
			};
		}
		/* A submenu that keeps its screen under a parent that shows its forms
		 * above lists on the app's first menu, by its own condition alone. */
		if (parentName !== undefined && carrier.aboveName === FIRST_MENU_NAME)
			return {
				title: `When ${name} appears`,
				lede: `${name} is a submenu whose parent ${parentName} shows its forms on ${FIRST_MENU_NAME}, so ${name} is listed there. A condition keeps it off that screen unless the condition matches.`,
				locus: [
					`CommCare checks this on ${FIRST_MENU_NAME}, before anyone opens ${name}${carrier.moduleIsBareCaseList ? " or sees its case list" : ""}.`,
				],
				scopeNote: NO_CASE_SCOPE_NOTE,
				sectionTitle: `Show ${name} when`,
				ruleRootLabel: "this module's condition",
				alwaysSummary: `${name} always appears`,
				menuSwitchLabel: MENU_SWITCH_LABEL,
				onTheMenuNote: `Workers find this module on ${FIRST_MENU_NAME}.`,
				offTheMenuNote: moduleOffTheMenuNote(platforms),
				settingTitle: SHOWN_ON_THE_MENU_TITLE,
				settingDescription: `Keep this module off ${FIRST_MENU_NAME} unless a condition matches`,
				clearLabel: "Always show",
				clearTitle: "Always show this module?",
				clearConsequence: `The condition will be removed and ${name} will appear on ${FIRST_MENU_NAME} for everyone. You can undo this change.`,
				backLabel: carrier.moduleIsBareCaseList
					? "Back to case list"
					: "Back to module",
			};
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
			alwaysSummary: `${name} always appears`,
			menuSwitchLabel: MENU_SWITCH_LABEL,
			onTheMenuNote:
				parentName === undefined
					? "Workers find this module on the home screen."
					: `Workers find this module inside ${parentName}.`,
			offTheMenuNote: moduleOffTheMenuNote(platforms),
			settingTitle: SHOWN_ON_THE_MENU_TITLE,
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
		menuSwitchLabel: MENU_SWITCH_LABEL,
		onTheMenuNote: `Workers find this form in ${moduleName}.`,
		offTheMenuNote: formOffTheMenuNote(platforms),
		settingTitle: SHOWN_ON_THE_MENU_TITLE,
		settingDescription:
			"Keep this form out of the list unless a condition matches",
		clearLabel: "Always show",
		clearTitle: "Always show this form?",
		clearConsequence: `The condition will be removed and ${name} will be offered every time. You can undo this change.`,
		backLabel: "Back to form",
	} as const;

	if (!carrier.caseFirst) {
		const blocker = carrier.caseFirstBlocker;
		const other =
			blocker?.otherModuleName === undefined
				? undefined
				: quoted(blocker.otherModuleName);
		const blockingForm =
			blocker?.blockingFormName === undefined
				? undefined
				: quoted(blocker.blockingFormName);
		const decides = `This condition decides whether ${name} is on that list.`;
		const locus =
			blocker?.reason === "first-menu"
				? `${name} shows on ${FIRST_MENU_NAME}, where people choose a form before any case. ${decides}`
				: blocker?.reason === "opens-without-a-case" &&
						other !== undefined &&
						blockingForm !== undefined
					? `${name} shows with ${other}'s forms on one screen, and ${blockingForm} there opens without a case, so people choose a form first and pick a case afterwards. ${decides}`
					: blocker?.reason === "chooses-another-case" && other !== undefined
						? `${name} shows with ${other}'s forms on one screen, and those forms choose a different case first, so people choose a form first and pick a case afterwards. ${decides}`
						: `${moduleName} holds a form that starts a new case, so people choose a form first and pick a case afterwards. ${decides}`;
		return {
			...shared,
			lede:
				blocker?.reason === "first-menu"
					? `The app's first menu lists ${name} before anyone picks a case, so CommCare checks this on that list.`
					: `${moduleName} shows its list of forms before anyone picks a case, so CommCare checks this on that list.`,
			locus: [locus],
			scopeNote: NO_CASE_SCOPE_NOTE,
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
	};
}
