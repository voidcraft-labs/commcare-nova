/**
 * The words of bringing an app in from CommCare HQ: the entries, the picker,
 * the reading screen, a stop, the account, the review, creating and landing,
 * what the Publishing card says afterwards, and what MCP answers.
 *
 * Client-safe: the screens and the MCP tools read these, so a person and a
 * client read one wording. A sentence with a value is a function named for
 * what it says. Words another file owns are not repeated here: a finding's
 * label, sentence and next step and a circumstance's block are
 * `hqFindingCopy.ts`'s, what the first publish changes is
 * `firstPublishCopy.ts`'s, a table's and the places' choices are
 * `managedData.ts`'s, and the claim marks of the picker are `hqAppClaims.ts`'s.
 * This file imports nothing of `lib/deployment`.
 */

import {
	inPlatform,
	PLATFORM_FEATURES,
	type Platform,
	type PlatformFeatureId,
} from "@/lib/domain/platforms";
import type { FindingStanding } from "./hqFindings";

/** `"1 menu"`, `"2 menus"`: a count with its noun, singular at one. */
function counted(n: number, singular: string, plural: string): string {
	return `${n} ${n === 1 ? singular : plural}`;
}

/**
 * CommCare HQ's name for an app, or null where it holds none. HQ stores a
 * blank name as it was typed, and a sentence never names an app by spaces.
 */
function namedApp(appName: string | null): string | null {
	return appName === null || appName.trim() === "" ? null : appName;
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

/** The labels of the flow's buttons and links. None ends in a period. */
export const BRING_IN_ACTIONS = {
	goToYourApps: "Go to your apps",
	chooseAnApp: "Choose an app",
	chooseAnotherApp: "Choose another app",
	chooseAnotherProject: "Choose another Project",
	checkAgain: "Check again",
	tryAgain: "Try again",
	openSettings: "Open Settings",
	openYourApp: "Open your app",
	done: "Done",
	cancel: "Cancel",
	readThisApp: "Read this app",
	copyTheList: "Copy the list",
	copied: "Copied",
	openInCommCareHq: "Open in CommCare HQ",
	showTheQuestions: "Show the questions",
	hideTheQuestions: "Hide the questions",
	bringItIn: "Bring it in",
	seeWhatCameIn: "See what came in",
	reload: "Reload",
} as const;

/** The action that opens the app once it is in: "Open {appName}". */
export function openAppAction(appName: string): string {
	return `Open ${appName}`;
}

// ---------------------------------------------------------------------------
// Entries
// ---------------------------------------------------------------------------

/** The home's button beside New app. */
export const BRING_IN_HOME_ENTRY = "Bring in from CommCare HQ";

/** The empty home's question under Get started, before its link. */
export const BRING_IN_EMPTY_STATE_QUESTION =
	"Already have an app in CommCare HQ?";

/** The empty home's link after that question. */
export const BRING_IN_EMPTY_STATE_LINK = "You can bring it in";

/** The new-app page's second button. */
export const BRING_IN_START_BUTTON = "Bring in an app from CommCare HQ";

/** The line under that button. */
export const BRING_IN_START_LINE =
	"Carry on in Nova with an app you already have";

// ---------------------------------------------------------------------------
// Choosing
// ---------------------------------------------------------------------------

export const PICKER_HEADING = "Bring in an app from CommCare HQ";

export const PICKER_LEAD =
	"Nova reads the app with your CommCare HQ account. Nothing changes in CommCare HQ until you publish from Nova.";

/** The label of the Project the app is added to. */
export const PICKER_PROJECT_LABEL = "Add it to";

/** Who can open the app in the Project it is added to, and what reading lookup tables means for it. */
export function pickerProjectLine(project: {
	readonly name: string;
	readonly personal: boolean;
}): string {
	return project.personal
		? "Only you can open it. An app that reads lookup tables stays in the Project it's added to."
		: `Everyone in ${project.name} can open it. An app that reads lookup tables stays in the Project it's added to.`;
}

export const PICKER_SPACE_LABEL = "Project space";

/** The one project space a connection reaches, stated in the field's place. `server` is the server's label. */
export function pickerOneSpaceLine(domain: string, server: string): string {
	return `${domain}, on CommCare HQ (${server})`;
}

export const PICKER_SPACE_PLACEHOLDER = "Search project spaces";

/** The placeholder of the list of two to eight project spaces, which takes no typing. */
export const PICKER_SPACE_SELECT_PLACEHOLDER = "Choose a project space";

/** The search of more than eight project spaces matches none of them. */
export const PICKER_SPACE_NO_MATCH = "No project space matches that";

export const PICKER_APP_LABEL = "App";

/** The status while a project space's apps are read. */
export function pickerAppsLoadingLine(domain: string): string {
	return `Reading the apps in ${domain}`;
}

/** A project space that holds no app. */
export function pickerNoAppsLine(domain: string): string {
	return `There are no apps in ${domain} yet`;
}

export const PICKER_APP_FILTER_PLACEHOLDER = "Search apps by name";

/** A filter that matches no app. */
export function pickerNoMatchLine(domain: string): string {
	return `No app in ${domain} matches that`;
}

/** An app CommCare HQ holds no name for. */
export const UNNAMED_HQ_APP = "An app with no name";

/** Beside the picker's footer. */
export const PICKER_FOOTER_LINE =
	"Reading creates nothing. You'll see what Nova found first.";

/** The description of Read this app while no app is chosen. */
export const PICKER_READ_WAITS_LINE =
	"You can read an app once you've chosen one";

export const BRING_IN_NOT_CONNECTED_TITLE =
	"Connect CommCare HQ to bring in an app";

export const BRING_IN_NOT_CONNECTED_BODY =
	"You can add your CommCare HQ API key in Settings. Nova uses it to read your app.";

/** The list of a project space's apps could not be read. */
export function pickerListFailedLine(domain: string): string {
	return `Nova couldn't list the apps in ${domain} just now. You can try again.`;
}

/** Check connection could not be read, in the picker and the Publish dialog. */
export const CONNECTION_CHECK_FAILED =
	"Nova couldn't check your connection just now. You can try again.";

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

/** The reading screen's status, naming the app where the page knows its name. */
export function readingStatusLine(appName: string | null): string {
	const app = namedApp(appName);
	return app === null
		? "Reading your app from CommCare HQ"
		: `Reading ${app} from CommCare HQ`;
}

/** After twenty seconds of reading. */
export const READING_SLOW_LINE =
	"Still reading. Apps with lots of pictures and sounds take a few minutes.";

export const READING_LEAVE_LINE =
	"You can leave this page. Nothing is created until you choose Bring it in, and Nova reads the app afresh when you come back.";

/** A first lost request, of a read or a create. */
export const TRYING_AGAIN = "Trying again";

/** A read's request lost twice. */
export const READING_LOST_LINE =
	"Nova lost its connection partway. Nothing was created, and you can try again.";

/**
 * A read lost twice under a create's lead: the read a `read-again` asked for,
 * after that create may have added files to the Project, so no "Nothing".
 */
export const READING_LOST_AFTER_CREATE_LINE =
	"Nova lost its connection partway. No app was created, and you can try again.";

/**
 * Nova's own failure in a read under a create's lead: the body of the read's
 * failed screen, in the form that stays true after that create added files
 * to the Project. Its title is the read's.
 */
export function readFailedAfterCreateBody(appName: string | null): string {
	return `Nova ran into a problem of its own while reading ${namedApp(appName) ?? "this app"}. That's on Nova, and the team has been told. No app was created, and nothing changed in CommCare HQ.`;
}

/** Any request of the flow answered that the session ended: the title, over its one line. */
export const SIGNED_OUT_TITLE = "You're signed out";

/** Under that title, beside the Reload action. */
export const SIGNED_OUT_LINE = "Reload the page to sign in again";

// ---------------------------------------------------------------------------
// A stop
// ---------------------------------------------------------------------------

/** Where a screen's answer came from: a read, or a create that did not create. */
export type BringInAnswerSource = "read" | "create";

/** Under every stop but one for an app already in Nova. */
export function stopNothingChangedLine(source: BringInAnswerSource): string {
	return source === "read"
		? "Nothing was created, and nothing changed in CommCare HQ"
		: "No app was created, and nothing changed in CommCare HQ";
}

// ---------------------------------------------------------------------------
// The account
// ---------------------------------------------------------------------------

/**
 * The account's heading: `yet` over anything a later Nova or a change in
 * CommCare HQ can let in, `this-time` where every finding is one of Nova's own
 * faults.
 */
export function accountHeadingLine(
	heading: "yet" | "this-time",
	appName: string | null,
): string {
	const app = namedApp(appName) ?? "this app";
	return heading === "yet"
		? `Nova can't bring in ${app} yet`
		: `Nova couldn't bring in ${app} this time`;
}

/** The lead under the account's heading. */
export function accountLead(
	heading: "yet" | "this-time",
	source: BringInAnswerSource,
): string {
	const nothing =
		source === "read"
			? "Nothing was created, and nothing changed in CommCare HQ."
			: "No app was created, and nothing changed in CommCare HQ.";
	return heading === "yet"
		? `${nothing} Nova only brings in an app when it can hold every part of it exactly, so nothing is lost when you publish back.`
		: nothing;
}

/** One part of the account's count line, for the findings of one standing. */
export function accountCountPart(standing: FindingStanding, n: number): string {
	switch (standing) {
		case "not-yet":
			return `${counted(n, "thing", "things")} Nova can't hold yet`;
		case "never":
			return `${counted(n, "thing", "things")} Nova doesn't bring in`;
		case "fix-in-hq":
			return `${counted(n, "thing", "things")} to change in CommCare HQ`;
	}
}

/**
 * The words before a finding's own name in CommCare HQ, which a screen sets
 * in monospace on a line of its own and the copied list writes after them.
 */
export const NAMED_IN_HQ_LEAD = "In CommCare HQ:";

/** The heading of the account's group of pictures and sounds. */
export const ACCOUNT_MEDIA_GROUP_HEADING = "Pictures and sounds";

/** The clipboard was refused, over the text shown to select. */
export const CLIPBOARD_REFUSED_LINE =
	"Your browser didn't let Nova copy this, so here it is to select and copy.";

/** A folded run of one sentence, said once over its questions. */
export function foldedRunLine(n: number): string {
	return `on ${n} questions`;
}

/** The copied text's first line. `date` is the day the read answered, already in the reader's locale. */
export function accountTextFirstLine(
	heading: string,
	domain: string,
	date: string,
): string {
	return `${heading} (${domain}, checked ${date})`;
}

// ---------------------------------------------------------------------------
// The review
// ---------------------------------------------------------------------------

/** The review's heading. `appName` is null where CommCare HQ holds no name for the app. */
export function reviewHeading(appName: string | null): string {
	return `Nova can bring in ${namedApp(appName) ?? "this app"}`;
}

export const REVIEW_LEAD =
	"Here's what comes in and what stays where it is. Nothing is created until you choose Bring it in.";

export const REVIEW_APP_SECTION = "Your app";

export const REVIEW_APP_NAME_LABEL = "App name";

/**
 * The name field's error where CommCare HQ holds no name for the app: the
 * refusal's own sentence offers to keep a name there is none of.
 */
export const REVIEW_NAME_NONE_IN_HQ =
	"The app needs a name of up to 255 characters. CommCare HQ holds none for it, so you can type one.";

/** The counts of what comes in, joined by the metadata separator. */
export function reviewCountsLine(counts: {
	readonly menus: number;
	readonly forms: number;
	readonly questions: number;
	readonly languages: number;
}): string {
	return [
		counted(counts.menus, "menu", "menus"),
		counted(counts.forms, "form", "forms"),
		counted(counts.questions, "question", "questions"),
		counted(counts.languages, "language", "languages"),
	].join(" · ");
}

/** The words before the case types' names, which a screen sets in monospace. */
export const REVIEW_CASE_TYPES_LEAD = "Case types:";

/** The case types the app holds, as one line. */
export function reviewCaseTypesLine(names: readonly string[]): string {
	return `${REVIEW_CASE_TYPES_LEAD} ${names.join(", ")}`;
}

/** The Project the app is added to, and who can open it there. */
export function reviewProjectLine(project: {
	readonly name: string;
	readonly personal: boolean;
}): string {
	return project.personal
		? `Added to ${project.name}. Only you can open it.`
		: `Added to ${project.name}. Everyone in ${project.name} can open it.`;
}

/** Where the app reads a lookup table. */
export function reviewTablesProjectLine(projectName: string): string {
	return `This app reads lookup tables, so it stays in ${projectName} once it's in.`;
}

export const REVIEW_RUNS_ON_SECTION = "Where workers use this app";

/** Under a choice that asks for the date and the time separately. */
export function splitDatetimeLine(questions: number): string {
	return questions === 1
		? "Nova asks for the date and the time separately in this app's date and time question, so Web Apps can run it"
		: `Nova asks for the date and the time separately in this app's ${questions} date and time questions, so Web Apps can run them`;
}

/** Why Nova chose the preselected declaration, by the review's reason. */
export const REVIEW_RUNS_ON_WHY: Readonly<
	Record<"content" | "web-apps-off-in-hq" | "keeps-web-apps", string>
> = {
	content: "Nova chose this from what the app uses.",
	"web-apps-off-in-hq":
		"CommCare HQ has Web Apps turned off for this app, so Nova chose Android only. The app can run in Web Apps too, and you can choose that here.",
	"keeps-web-apps":
		"This app's date and time questions can't run in Web Apps as they are, and CommCare HQ has Web Apps turned on for it. Nova chose to ask for the date and the time separately so it keeps running there.",
};

/** The chosen declaration leaves Web Apps out while CommCare HQ has it on. */
export const REVIEW_WEB_APPS_ASKS_OFF =
	"CommCare HQ has Web Apps turned on for this app. Your first publish asks before turning it off.";

/** The chosen declaration includes Web Apps while CommCare HQ has it off. */
export const REVIEW_WEB_APPS_ASKS_ON =
	"CommCare HQ has Web Apps turned off for this app. Your first publish asks before turning it on.";

/**
 * Why the app cannot run on one platform: the features as list items under a
 * lead, and the files' sentence. `entry` is one member of the review's
 * platforms the app is kept off, typed by its shape.
 */
export function platformOutBlock(entry: {
	readonly platform: Platform;
	readonly features: readonly PlatformFeatureId[];
	readonly media: boolean;
}): {
	/** The features' lead, where `entry.features` is not empty; null where only files keep it out. */
	readonly lead: string | null;
	/** Each feature's label, in `entry.features`' order. */
	readonly features: readonly string[];
	/** The files' sentence, null where `media` is false. */
	readonly files: string | null;
} {
	const where = inPlatform(entry.platform);
	const lead =
		entry.features.length > 0
			? `This app can't run ${where} because of what it uses:`
			: null;
	const files = !entry.media
		? null
		: lead === null
			? `This app can't run ${where}: some of its pictures, sounds or videos don't play there.`
			: "Some of its pictures, sounds or videos don't play there either.";
	return {
		lead,
		features: entry.features.map((feature) => PLATFORM_FEATURES[feature].label),
		files,
	};
}

export const REVIEW_CHANGE_LATER = "You can change this later in App settings.";

export const REVIEW_TABLES_SECTION = "Lookup tables";

/** A table's choice left unanswered when Bring it in is pressed. */
export const REVIEW_CHOICE_MISSING =
	"This one needs your choice before Nova can create the app";

/** A table neither of whose answers is offered. */
export const REVIEW_NO_CHOICE_OPEN =
	"Neither choice is open to you here. You can go back and add this app to another Project.";

export const REVIEW_PLACES_SECTION = "Places";

export const REVIEW_MEDIA_SECTION = "Pictures and sounds";

export const REVIEW_STAYS_SECTION = "Stays as it is in CommCare HQ";

export const REVIEW_AFTER_SECTION = "After it's in";

/** The first line under After it's in. */
export function reviewAfterPublishLine(domain: string): string {
	return `You can keep working on it in Nova and publish back to this app in ${domain}.`;
}

export const REVIEW_AFTER_DRIFT_LINE =
	"If someone changes it in CommCare HQ, your next publish stops before sending anything, lists what changed, and offers to bring it in to Nova.";

/** A brought-in app published to another project space: the review's line and the Publish dialog's plan line. */
export const ANOTHER_SPACE_NEW_APP_LINE =
	"Publishing to another project space makes a new app there. A copy your team already keeps there stays as it is.";

// ---------------------------------------------------------------------------
// Creating and landing
// ---------------------------------------------------------------------------

export const CREATING_STATUS = "Creating your app";

export const CREATING_LEAD =
	"Nova reads the app once more, so it creates exactly what you reviewed.";

/** A create's request lost twice. */
export const CREATING_LOST_LINE =
	"Nova lost its connection while creating your app. Trying again is safe: if the app was created, Nova opens it.";

/** After twenty seconds of creating. */
export const CREATING_SLOW_LINE =
	"Still bringing it in. Apps with lots of pictures and sounds take a few minutes.";

export const CREATING_LEAVE_LINE =
	"You can leave this page. If Nova finishes, your app will be in your apps. If it doesn't, no app is created, and you can bring it in again.";

export const BROUGHT_IN_TOAST_TITLE = "Your app is here";

export function broughtInToastBody(name: string, domain: string): string {
	return `Nova brought in ${name} from ${domain}. Publishing shows where it came from and what stays in CommCare HQ.`;
}

// ---------------------------------------------------------------------------
// After the app is in
// ---------------------------------------------------------------------------

/** The Publishing card, under the project space. */
export function broughtInFromLine(
	domain: string,
	date: string,
	name: string,
): string {
	return `Brought in from “${domain}” on ${date} by ${name}`;
}

/** The rung On CommCare HQ, before Nova's first publish. `date` is the day the app was brought in. */
export function notPublishedYetLine(date: string): string {
	return `Nova read this app from CommCare HQ on ${date} and hasn't published to it yet`;
}

/** The drift stop's heading, beside the list of changes. */
export const DRIFT_STOP_LEAVE_HEADING =
	"Or leave CommCare HQ's version as it is";

/** The drift stop, for an editor. */
export const DRIFT_STOP_EDITOR_LINE =
	"An admin or owner of this Project can also stop publishing here, which leaves CommCare HQ's version as it is.";

/** The dialog, after stopping. */
export function stoppedPublishingLine(domain: string): string {
	return `Nova stopped publishing this app to “${domain}”. The app in CommCare HQ stays as it is.`;
}

export const STOP_PUBLISHING_FAILED =
	"Nova couldn't stop publishing just now. Nothing was changed, and you can try again.";

/** A stop whose answer never arrived, so it may have landed (D10b). */
export const STOP_PUBLISHING_UNANSWERED =
	"Nova lost its connection before it heard whether publishing stopped here. Nova is checking where this app stands, so you can see what happened before you try again.";

/** The restore toast's title. */
export const RESTORED_TOAST_TITLE =
	"Your app is back, and where it publishes changed";

/** The Publish dialog's compact row of an ended deployment. */
export const PUBLISHING_STOPPED_ROW = "Publishing stopped";

// ---------------------------------------------------------------------------
// MCP
// ---------------------------------------------------------------------------

/** `bring_in_hq_app`, created. */
export function broughtInToolMessage(name: string, domain: string): string {
	return `${name} is in Nova. Nothing changed in CommCare HQ. Publishing from Nova updates the app it came from in ${domain}.`;
}

/** `refresh_managed_data`, sent both targets or neither. */
export const REFRESH_MANAGED_DATA_TARGET_MESSAGE =
	"Send table_id to refresh one lookup table, or app_id to refresh that app's places. This call sent both or neither.";

/** `list_hq_apps` with no CommCare HQ connection. */
export const LIST_HQ_APPS_NOT_CONFIGURED =
	"CommCare HQ is not configured. Add your HQ credentials in Settings before listing a project space's apps.";

/** `read_hq_app` or `bring_in_hq_app` with no CommCare HQ connection. */
export const READ_HQ_APP_NOT_CONFIGURED =
	"CommCare HQ is not configured. Add your HQ credentials in Settings before reading an app.";

/** `read_hq_app`, a page the app no longer matches. */
export const READING_RESTARTED_MESSAGE =
	"This app changed in CommCare HQ since the last page, so Nova read it again. Here is what Nova found, from the start.";
