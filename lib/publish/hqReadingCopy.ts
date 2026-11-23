/**
 * The words a person reads about bringing an app in from CommCare HQ, beside
 * the findings and circumstances `hqFindingCopy.ts` words: why a request was
 * refused, the one sentence above what a create that did not create carries,
 * each stage the work names as it moves, the line under an account longer
 * than the answer lists, the landing a tab could not open, and Nova's own
 * failure.
 *
 * Client-safe: the bring-in page and the MCP tools read it, so a person and a
 * client read one wording. "Reading" is the code's word for one read of one
 * HQ app; no sentence here says it.
 */

import type { ReadingRefusal, ReadingStage } from "@/lib/deployment";

const COUNT_FORMAT = new Intl.NumberFormat("en-US");

/** The sentence for each refusal, which a route answers as `error` beside the code. */
export const READING_REFUSAL_COPY: Readonly<Record<ReadingRefusal, string>> = {
	session_ended: "Your sign-in has ended. Sign in again to continue.",
	no_project_access:
		"You don't have edit access to this Project, so Nova can't add an app to it. You can choose another Project, or ask one of its admins for edit access.",
	invalid_input:
		"Nova couldn't read that request. Reloading the page and trying again usually fixes it.",
	name_missing:
		"The app needs a name of up to 255 characters. You can keep the one from CommCare HQ or type another.",
	choice_not_offered:
		"One of the choices sent isn't one this review offers. The review may have changed, so you can reload it and choose again.",
	choice_missing:
		"A lookup table this app reads needs your choice before Nova can create the app. You can choose what to do with it in the review.",
	project_changed:
		"A file this app uses was removed from your Project while Nova was creating the app, so Nova stopped before creating it. You can bring it in again, and Nova adds the file back.",
	app_unavailable:
		"This app was brought in already, and you can't open it from here. If it's in recently deleted, you can restore it from your apps. If you've left its Project, one of its admins can add you back.",
	publish_in_flight:
		"Nova is still finishing a publish to this app in CommCare HQ, so it can't be brought in just yet. You can try again in a few minutes.",
};

/** One sentence above whatever a create that did not create carries. */
export const CREATE_ANSWER_LEADS: {
	/** By what `now` holds. A stop of `already-in-nova` has its own. */
	readonly changed: Readonly<
		Record<"review" | "account" | "stop" | "already-in-nova", string>
	>;
	readonly "read-again": string;
	readonly "check-failed": string;
	readonly held: string;
	/**
	 * Added after a `changed` or `read-again` lead where an answer could not be
	 * kept: a dropped declaration goes back to the review's preselected one, a
	 * dropped table answer goes back to no answer, so the sentence says neither
	 * that Nova chose nor that nothing is chosen.
	 */
	readonly choicesDropped: string;
} = {
	changed: {
		review:
			"Something changed since you reviewed this app, so Nova read it again. Here is the review as it stands now.",
		account:
			"Something changed since you reviewed this app, and Nova can't bring it in as it stands now. Here is what Nova found. No app was created.",
		stop: "Nova couldn't finish creating this app. Here is where things stand. No app was created.",
		"already-in-nova":
			"This app was brought into Nova after you reviewed it, so Nova didn't create a second one. Any pictures and sounds Nova already added to your Project stay in its files.",
	},
	"read-again":
		"A lookup table this app reads changed in your Project while Nova was creating the app, so Nova is reading it again. No app was created. Any pictures and sounds Nova already added to your Project stay in its files, and bringing the app in uses them.",
	"check-failed":
		"Nova stopped before creating this app. Any pictures and sounds Nova already added to your Project stay in its files.",
	held: "Nova stopped before creating anything. Your review is still here.",
	choicesDropped:
		"Some of your choices no longer apply, so those are back to how the review offers them.",
};

/** Of the files a media stage plans, how many have a verdict or are published. */
type FileCount = { readonly done: number; readonly total: number };

function withCount(label: string, count: FileCount | null): string {
	return count === null
		? label
		: `${label}, ${COUNT_FORMAT.format(count.done)} of ${COUNT_FORMAT.format(count.total)}`;
}

/**
 * Each stage by name. A media stage's label is a function of the last count
 * its stream gave, and takes none between the stage's own line and its first
 * count; an MCP progress message is the form with none.
 */
export const READING_STAGE_LABELS: {
	readonly [S in Exclude<
		ReadingStage,
		"checking-media" | "bringing-in-media"
	>]: string;
} & {
	readonly "checking-media": (count: FileCount | null) => string;
	readonly "bringing-in-media": (count: FileCount | null) => string;
} = {
	connecting: "Connecting to CommCare HQ",
	"reading-app": "Reading the app",
	"reading-project-data": "Reading its lookup tables and places",
	checking: "Checking what Nova read",
	"checking-media": (count) => withCount("Checking pictures and sounds", count),
	"bringing-in-media": (count) =>
		withCount("Bringing in pictures and sounds", count),
	creating: "Creating your app",
};

/**
 * The line under an account that lists fewer findings than the read met.
 * The rest are not said to be like the ones shown: the list is in the app's
 * order, so what is cut off is whatever came last, of any kind.
 */
export function moreFindingsLine(more: number): string {
	return more === 1
		? "Nova found 1 more thing to list and counted it. This list shows the first 2,000."
		: `Nova found ${COUNT_FORMAT.format(more)} more things to list and counted every one. This list shows the first 2,000.`;
}

/** The landing of a brought-in app whose receipt this tab could not read. */
export const UNVERIFIED_LANDING_TITLE =
	"Your app is in, and this tab couldn't open it";
export const UNVERIFIED_LANDING_BODY =
	"Nova brought your app in, but couldn't open it in this tab. It's in your apps, in the Project you added it to.";

/** CommCare HQ's name for the app, or "this app" where there is none to say. */
function appInWords(app: string | null): string {
	return app === null || app.trim() === "" ? "this app" : app;
}

/** What the page shows where a request's stream ended in a `failed` line. */
export const READING_FAILED_COPY: Readonly<
	Record<
		"read" | "create",
		{
			readonly title: string;
			/** `app` is CommCare HQ's name for the app, or null where it is not known. */
			readonly body: (app: string | null) => string;
		}
	>
> = {
	read: {
		title: "Couldn't read this app",
		body: (app) =>
			`Nova ran into a problem of its own while reading ${appInWords(app)}. That's on Nova, and the team has been told. Nothing was created, and nothing changed in CommCare HQ.`,
	},
	create: {
		title: "Couldn't create your app",
		body: (app) =>
			`Nova ran into a problem of its own while creating ${appInWords(app)}. That's on Nova, and the team has been told. No app was created. Trying again is safe: if the app was created after all, Nova opens it.`,
	},
};
