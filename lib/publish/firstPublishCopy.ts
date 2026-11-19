/**
 * What a person reads about what an app's first publish after Nova brought
 * it in changes in CommCare HQ: the one renderer and the one copy, so the
 * review, the publish dialog and MCP word one list the same way.
 *
 * Client-safe. No sentence takes an argument: none names a question, a
 * menu, a count or a project space, so one string serves every surface.
 */

import {
	FIRST_PUBLISH_CHANGE_IDS,
	FIRST_PUBLISH_TOUCHES_WORKERS,
	type FirstPublishSentenceId,
	type FirstPublishView,
	firstPublishSentenceId,
} from "./firstPublishChangeIds";
import {
	NEXT_PUBLISH_DIALOG_LEAD,
	NEXT_PUBLISH_HEADING,
} from "./hqChangesCopy";

export const FIRST_PUBLISH_HEADING = "What the first publish changes";

/** The lead on the review, before the app is brought in. */
export const FIRST_PUBLISH_LEAD_REVIEW =
	"Nova writes an app in its own way. This is everything that will differ in CommCare HQ the first time you publish this app back.";

/** The lead in the publish dialog, before the first publish. */
export const FIRST_PUBLISH_LEAD_PUBLISH =
	"This is the first publish since Nova brought this app in. Along with your edits, these things will differ in CommCare HQ.";

export const FIRST_PUBLISH_WORKERS_LABEL = "Workers will notice";

export const FIRST_PUBLISH_HQ_LABEL = "Only in CommCare HQ";

/** Shown exactly where no line of the list touches workers. */
export const FIRST_PUBLISH_NO_WORKER_CHANGE =
	"Workers see the same questions, and their answers save to the same places.";

export const FIRST_PUBLISH_FORM_BUILDER_NOTE =
	"If your team opens these forms in CommCare HQ's form builder, some hidden details will look different there.";

/** One sentence for each id that has a line of its own. */
export const FIRST_PUBLISH_SENTENCES: Readonly<
	Record<FirstPublishSentenceId, string>
> = {
	"forms-and-settings-rewritten":
		"Nova writes this app's forms, case lists, searches and settings again in its own way. Apart from anything listed here, each form asks, shows and saves the same things, and each list and search finds, shows and sorts the same cases, with the same limit on how many a worker can select.",
	"hidden-values-added":
		"Nova adds, renames or removes some hidden values in this app's forms. Their names start with nova_. CommCare HQ's form builder lists them, and form exports start a new column for each new name.",
	"case-names-checked":
		"A question that gives a case its name now needs an answer that isn't blank. A case name or an external ID longer than 255 characters is turned down, and both are saved without spaces at their ends.",
	"validation-counts-moved":
		"A validation rule that counts another question's answers now counts only that question's answers. Before, CommCare could count the answer being checked instead.",
	"validation-messages-composed":
		"A validation message that shows an answer now shows exactly that answer. Where the answer can't be read, workers see CommCare's own message.",
	"instant-comparison":
		"An expression that compares two dates and times is now written so it compares the same moment in every time zone. In CommCare HQ's form builder these expressions will look longer.",
	"empty-rows-guard":
		"An expression that reads a lookup table, your places or a search answer now reads blank when there is nothing to read. Before, it stopped the form.",
	"absent-session-value-guard":
		"An expression that reads the screen width or the app's language now reads blank where CommCare has none to give. Before, it stopped the form.",
	"row-predicate-current":
		"Inside a repeat, a choice filter that names another question of that repeat now reads this entry's answer. Before, CommCare stopped on it or used one entry's answer for every entry.",
	"search-value-guards":
		"A search value that holds a quote mark is now matched as typed, and a value CommCare HQ can't search by finds no cases. Before, the search failed.",
	"search-today-device-day":
		"A search filter that uses today's date now uses the worker's day. In CommCare HQ it used the project space's day, which differs for a worker in another time zone.",
	"case-settings-respelled":
		"Nova writes each form's case settings in its own way, so some of them can look different on CommCare HQ's case management page. Where a form loads a value from its case, that page stops listing it, and the question holds it as its default value. What each form saves and loads stays the same.",
	"sort-rule-kept-as-hidden-column":
		"A sort rule over a property the list doesn't show is kept as a hidden column. Lists sort the same way.",
	"search-filter-joined-to-list":
		"Where a menu's forms read its search, Nova keeps the search's filter and the case list's filter as one. The search finds the same cases.",
	"search-restates-list-filter":
		"Nova sends a case list's filter with its search, so a search that matched more cases than CommCare HQ returns at once can show cases it left out before.",
	"link-held-case-guards-added":
		"A form that opens another form with a case it carries will open it only when that case is on the device. Nova adds that check to each such link.",
	"registration-label-fixed":
		"A Register button that had no text of its own in CommCare HQ, in every language or in just one, now always reads “Create a new Case” there. Before, CommCare HQ filled in the words each time it made a build, so they could differ between builds. You can change the text in Nova.",
	"date-and-time-saved-as-hq-stores-it":
		"A date and time that a form saves to a case is now written the way CommCare HQ stores it. Before, a phone wrote it in its own time zone for the cases it saved, so a list sorted by that date and time could show those cases out of place.",
	"connect-app-captures-location":
		"Every form of this CommCare Connect app will record where it was filled in. Nova turns on Auto Capture Location for the app in CommCare HQ.",
	"translation-overrides-folded":
		"A wording set in CommCare HQ's app translations for the app's, a menu's or a form's name becomes that name. Workers read the same words.",
	"location-list-setting-reset":
		"This app's own setting for the location list goes back to the project space's default. The app reads places the same way.",
	"web-apps-turned-off":
		"Web Apps is turned off for this app in CommCare HQ, because the app is set to run on Android only.",
	"web-apps-turned-on":
		"Web Apps is turned on for this app in CommCare HQ, because the app is set to run in Web Apps.",
	"date-and-time-questions-split":
		"Each date and time question becomes a date question and a time question, so the app runs in Web Apps. A case still gets one date and time from the two.",
	"blank-translations-filled":
		"A text left blank in one language is written in the app's first language for that language, as CommCare HQ's form builder does when a form is saved there.",
	"media-paths-joined":
		"Where CommCare HQ holds one picture, sound or video under several names, the app now uses one of them. Workers see and hear the same files.",
	"media-files-renamed":
		"Some pictures, sounds and videos get new names in CommCare HQ, because Nova can't keep the names they had. Phones download them again with the next version of the app.",
	"media-references-with-no-file-removed":
		"References to pictures, sounds and videos that have no file in CommCare HQ are removed. Workers saw nothing there.",
	"broken-pictures-removed":
		"Icons that have no file in CommCare HQ are removed. Web Apps showed an empty or broken picture in their place, and Android showed nothing. You can choose a new icon in Nova.",
	"unused-media-entries-removed":
		"CommCare HQ drops the entries of this app's media list that nothing in the app uses. The files themselves stay in CommCare HQ.",
	"text-spaces-dropped":
		"A name, label or other app text that is only spaces in one language now shows its text in the source language there, and spaces or line breaks at the start or end of a text are dropped. Before, workers saw a blank text, the spaces or the line breaks.",
	"form-text-characters-written-as-outputs":
		"Where a question's text holds a no-break space, or words CommCare HQ would take as a request for data, Nova writes those characters as fixed values. CommCare HQ's form builder shows each one as a small reference inside the text. Workers read the same words.",
	"hidden-value-defaults-dropped":
		"A hidden value that held both a starting value and a calculation keeps only its calculation. CommCare always replaced the starting value before anything read it.",
	"sort-by-entry-with-a-blank-name-dropped":
		"On Android, a case list's Sort by no longer lists a choice with no name. CommCare HQ listed a hidden column there whose name was blank in every language, so workers saw an empty choice. You can give its sort rule a name in Nova to list it again.",
};

/** One line of a list: the id whose sentence it shows, and that sentence. */
export interface FirstPublishLine {
	readonly id: FirstPublishSentenceId;
	readonly sentence: string;
}

/** Everything a surface shows of one list, in the order it shows it. */
export interface FirstPublishLines {
	/** `FIRST_PUBLISH_HEADING`, or `NEXT_PUBLISH_HEADING` for a list of kind `next-publish`. */
	readonly heading: string;
	/**
	 * `FIRST_PUBLISH_LEAD_REVIEW` or `FIRST_PUBLISH_LEAD_PUBLISH`, by
	 * `surface`, or `NEXT_PUBLISH_DIALOG_LEAD` for a list of kind
	 * `next-publish`.
	 */
	readonly lead: string;
	/** `FIRST_PUBLISH_WORKERS_LABEL`, and the lines that touch workers, in registry order. */
	readonly workers: {
		readonly label: string;
		readonly lines: readonly FirstPublishLine[];
	};
	/** `FIRST_PUBLISH_HQ_LABEL`, and the other lines, in registry order. */
	readonly hqOnly: {
		readonly label: string;
		readonly lines: readonly FirstPublishLine[];
	};
	/** `FIRST_PUBLISH_NO_WORKER_CHANGE` exactly where `view.touchesWorkers` is false; else null. */
	readonly reassurance: string | null;
	/** `FIRST_PUBLISH_FORM_BUILDER_NOTE`, always. */
	readonly note: string;
}

function sentenceOf(id: FirstPublishSentenceId): string {
	const sentence: string | undefined = FIRST_PUBLISH_SENTENCES[id];
	if (sentence === undefined) {
		throw new Error(
			"Nova was asked for the sentence of a first-publish change it has no words for. Every id of FIRST_PUBLISH_CHANGE_IDS has a sentence in FIRST_PUBLISH_SENTENCES, its own or the one FIRST_PUBLISH_SAID_BY names, and a stored list is checked against those ids where it is read (lib/deployment/store.ts::readFirstPublishStates), so look at the caller that built this list by hand.",
		);
	}
	return sentence;
}

/**
 * Everything a surface shows of `view`. Each id is shown by the sentence
 * `firstPublishSentenceId` names, once, in registry order, so a list can
 * hold fewer lines than the view has ids. Lines are split by
 * `FIRST_PUBLISH_TOUCHES_WORKERS`.
 */
export function firstPublishLines(
	view: FirstPublishView,
	surface: "review" | "publish",
): FirstPublishLines {
	const said = new Map<FirstPublishSentenceId, string>();
	for (const id of view.ids) {
		const sentenceId = firstPublishSentenceId(id);
		said.set(sentenceId, sentenceOf(sentenceId));
	}
	const workers: FirstPublishLine[] = [];
	const hqOnly: FirstPublishLine[] = [];
	for (const id of FIRST_PUBLISH_CHANGE_IDS) {
		const sentenceId = firstPublishSentenceId(id);
		const sentence = sentenceId === id ? said.get(sentenceId) : undefined;
		if (sentence === undefined) continue;
		const line = { id: sentenceId, sentence };
		(FIRST_PUBLISH_TOUCHES_WORKERS[sentenceId] ? workers : hqOnly).push(line);
	}
	const nextPublish = view.of === "next-publish";
	return {
		heading: nextPublish ? NEXT_PUBLISH_HEADING : FIRST_PUBLISH_HEADING,
		lead: nextPublish
			? NEXT_PUBLISH_DIALOG_LEAD
			: surface === "review"
				? FIRST_PUBLISH_LEAD_REVIEW
				: FIRST_PUBLISH_LEAD_PUBLISH,
		workers: { label: FIRST_PUBLISH_WORKERS_LABEL, lines: workers },
		hqOnly: { label: FIRST_PUBLISH_HQ_LABEL, lines: hqOnly },
		reassurance: view.touchesWorkers ? null : FIRST_PUBLISH_NO_WORKER_CHANGE,
		note: FIRST_PUBLISH_FORM_BUILDER_NOTE,
	};
}
