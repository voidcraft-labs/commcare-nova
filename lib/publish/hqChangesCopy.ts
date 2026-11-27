/**
 * What a person reads about changes made in CommCare HQ that Nova can bring
 * in to the app: the panel's headings, leads, buttons and the sentence under
 * each, its case data lines and next-publish block, each state it can be in
 * and each stop, the publish dialog's headline above it, and the lines of
 * the Publishing card, the builder's header and the other open tabs.
 *
 * Client-safe, and it imports nothing of `lib/deployment` or
 * `lib/commcare`: the builder, MCP and the server's refusal read one text.
 * `{since}` is one of `sincePhrase`'s three phrases.
 */

import { inPlatform, type Platform } from "@/lib/domain/platforms";
import {
	type DriftDateOptions,
	type DriftReference,
	driftDate,
} from "./driftReference";
import type {
	CasePropertyRename,
	HqChangeHeld,
	HqChangesStage,
	HqChangesUnavailable,
} from "./hqChangesKinds";
import { renameNamesReused } from "./hqChangesKinds";
import { namesInWords } from "./planFeatures";

const COUNT_FORMAT = new Intl.NumberFormat("en-US");

function count(n: number): string {
	return COUNT_FORMAT.format(n);
}

/**
 * Since when a change in CommCare HQ is measured, as the panel's sentences
 * name it: Nova's last publish to the project space, the day Nova brought
 * the app in, or Nova's last bring-in of changes from it.
 */
export function sincePhrase(
	since: DriftReference,
	domain: string,
	options?: DriftDateOptions,
): string {
	switch (since.kind) {
		case "published":
			return `Nova last published this app to “${domain}”`;
		case "brought-in":
			return `Nova brought this app in on ${driftDate(since.at, options)}`;
		case "changes-brought-in":
			return `Nova last brought in changes from “${domain}”`;
		default: {
			const unplaced: never = since;
			return unplaced;
		}
	}
}

// ── Loading ──────────────────────────────────────────────────────────

/** Of the files a media stage checks, how many have a verdict. */
type FileCount = { readonly done: number; readonly total: number };

/**
 * Each stage by name: the review's four, then the bring-in's two more. The
 * check of pictures and sounds takes the last count its stream gave, and
 * none before its first.
 */
export const HQ_CHANGES_STAGE_LABELS: {
	readonly [S in Exclude<HqChangesStage, "checking-media">]: string;
} & { readonly "checking-media": (count: FileCount | null) => string } = {
	"reading-app": "Reading the app in CommCare HQ",
	"reading-project-data": "Reading its lookup tables",
	checking: "Checking what changed",
	"checking-media": (files) =>
		files === null
			? "Checking pictures and sounds"
			: `Checking pictures and sounds (${count(files.done)} of ${count(files.total)})`,
	"adding-media": "Adding pictures and sounds to this Project",
	"bringing-in": "Bringing the changes in",
};

/** Beside the stage row after ten seconds. */
export const HQ_CHANGES_STILL_READING =
	"Still reading. A large app can take a little while.";

// ── The lists ────────────────────────────────────────────────────────

export const HQ_CHANGES_HEADING = "What changed in CommCare HQ";
export const NOVA_CHANGES_HEADING = "What changed in Nova since then";

/**
 * The lead under `HQ_CHANGES_HEADING`. `removes`: taking CommCare HQ's
 * version removes something that changed in Nova, so Nova's list follows
 * and the lead offers nothing on its own.
 */
export function hqChangesLead(since: string, removes: boolean): string {
	return removes
		? `These changed in CommCare HQ since ${since}.`
		: `These changed in CommCare HQ since ${since}. You can bring them in to Nova. Everything else in this app stays as it is.`;
}

export const NOVA_CHANGES_LEAD =
	"Nova doesn't combine the two, so this is a choice between them.";

/** The button where nothing in Nova would be removed: bring the changes in. */
export const BRING_IN_CHANGES_ACTION = "Bring in these changes";
export const USE_HQ_VERSION_ACTION = "Use CommCare HQ's version";
export const USE_HQ_VERSION_HELPER =
	"This app takes CommCare HQ's changes. The changes listed under Nova are removed, and Nova can't put them back.";
export const PUBLISH_OVER_HQ_ACTION = "Publish over CommCare HQ's changes";
export const PUBLISH_OVER_HQ_HELPER =
	"CommCare HQ takes this app's version. What changed there is replaced.";
/** Under `BRING_IN_CHANGES_ACTION`, in the publish dialog only, beside `PUBLISH_OVER_HQ_ACTION`. */
export const PUBLISH_OVER_INSTEAD_LINE =
	"Or you can publish over them, which replaces them with this app's version.";
/** Under the project space's plan line, where the dialog was opened to publish over a change. */
export const PUBLISH_OVER_CHOSEN_LINE =
	"This publish replaces what changed in CommCare HQ with this app's version.";
export const COPY_BOTH_LISTS_ACTION = "Copy both lists";
export const LISTS_COPIED_LINE = "Both lists copied.";
export const LISTS_NOT_COPIED_LINE =
	"Nova couldn't copy the lists here. You can select them above and copy them yourself.";
/** The ghost button under a list longer than ten lines. */
export function showAllAction(n: number): string {
	return `Show all ${count(n)}`;
}
export const CHECK_AGAIN_ACTION = "Check again";

/** Shared recovery beside complete rename evidence in the Builder and MCP pages. */
export function renameRecoveryLine(reused: boolean): string {
	return reused
		? "A name was reused, so reversing the listed changes could move the wrong case values. You can check your case properties and saved values in Nova before deciding which app to keep."
		: "If these names still identify the same case properties, you can rename them back in Nova and check again. Their saved values move with them.";
}

/**
 * A case property renamed in Nova since then holds "Use CommCare HQ's
 * version" back, and this line stands in its place. A property is a case type's, so each is named with its
 * type: two types can hold one name, and the person renames it back on the
 * type it was renamed on.
 */
export function renamedInNovaLine(
	renames: readonly CasePropertyRename[],
	reused = renameNamesReused(renames),
): string {
	if (reused) {
		const listed = renames
			.map((move) => `“${move.from}” to “${move.to}” on “${move.caseType}”`)
			.join(", ");
		return `Nova’s published comparison records ${listed}. ${renameRecoveryLine(true)}`;
	}
	if (renames.length === 1) {
		const [rename] = renames;
		return `Since then, the case property “${rename.from}” of the case type “${rename.caseType}” was renamed to “${rename.to}” in Nova. If “${rename.to}” still names the same property, you can rename it back in Nova and check again. Its saved values move with it.`;
	}
	const types = new Set(renames.map((rename) => rename.caseType));
	const oneType = types.size === 1;
	const pairs = renames.map(
		(rename) =>
			`“${rename.from}” to “${rename.to}”${oneType ? "" : ` on “${rename.caseType}”`}`,
	);
	const listed = `${pairs.slice(0, -1).join(", ")}, and ${pairs[pairs.length - 1]}`;
	const where = oneType ? ` on the case type “${renames[0].caseType}”` : "";
	return `Since then, Nova recorded ${listed}${where}. ${renameRecoveryLine(false)}`;
}

// ── The case data lines ──────────────────────────────────────────────

/** The most names a case data line lists before it counts the rest. */
const CASE_DATA_NAMES = 5;

/** Each entry in quotation marks, five at most, then "and {n} more". */
function cutNames(quoted: readonly string[]): string {
	const shown = quoted.slice(0, CASE_DATA_NAMES);
	const rest = quoted.length - shown.length;
	return rest > 0
		? `${shown.join(", ")} and ${count(rest)} more`
		: namesInWords(shown);
}

function quotedNames(names: readonly string[]): string {
	return cutNames(names.map((name) => `“${name}”`));
}

/**
 * The case properties the app no longer has, whose values cases saved in
 * Nova lose. A property is a case type's, so the line names the type: one
 * type's loss is not the app's where another type keeps that name.
 */
export function caseDataLine(
	properties: readonly { readonly caseType: string; readonly name: string }[],
): string {
	const types = new Set(properties.map((property) => property.caseType));
	if (types.size === 1) {
		const [caseType] = types;
		if (properties.length === 1)
			return `The case type “${caseType}” no longer has the case property “${properties[0].name}”, so its cases saved in Nova lose that value the next time each one is saved.`;
		return `The case type “${caseType}” no longer has the case properties ${quotedNames(properties.map((property) => property.name))}, so its cases saved in Nova lose those values the next time each one is saved.`;
	}
	return `The app no longer has the case properties ${cutNames(properties.map((property) => `“${property.name}” on “${property.caseType}”`))}, so cases saved in Nova lose those values the next time each one is saved.`;
}

/** The case types the app no longer has, whose cases saved in Nova are kept. */
export function caseTypesLine(caseTypes: readonly string[]): string {
	if (caseTypes.length === 1)
		return `The app no longer has the case type “${caseTypes[0]}”. Its cases saved in Nova are kept, and no list in this app shows them.`;
	return `The app no longer has the case types ${quotedNames(caseTypes)}. Their cases saved in Nova are kept, and no list in this app shows them.`;
}

/**
 * The lines a review says for where CommCare HQ now keeps what the document
 * doesn't hold: a form's id, the case id a create keyed by an answer files its
 * cases under, a file's path, the name a case list column gives its property.
 * Nova follows each, so the app is unchanged and the next publish keeps it.
 * `formIds` and `keyedPrefixes` are form names, `columnFields` menu names.
 */
export function whereHqKeepsLines(changes: {
	readonly formIds: readonly string[];
	readonly keyedPrefixes: readonly string[];
	readonly mediaPaths: number;
	readonly columnFields: readonly string[];
}): readonly string[] {
	const quoted = (names: readonly string[]) =>
		namesInWords(names.map((name) => `“${name}”`));
	const lines: string[] = [];
	if (changes.keyedPrefixes.length > 0) {
		const one = changes.keyedPrefixes.length === 1;
		lines.push(
			`In CommCare HQ, ${quoted(changes.keyedPrefixes)} now ${one ? "files the cases it makes" : "file the cases they make"} from an answer under a new case id. Nova follows it, so a key a worker enters again reaches the case CommCare HQ holds for it.`,
		);
	}
	if (changes.formIds.length > 0) {
		const one = changes.formIds.length === 1;
		lines.push(
			`In CommCare HQ, ${quoted(changes.formIds)} ${one ? "has a new form id" : "have new form ids"}. Nova follows ${one ? "it" : "them"}.`,
		);
	}
	if (changes.mediaPaths > 0) {
		const one = changes.mediaPaths === 1;
		lines.push(
			`In CommCare HQ, ${one ? "one media file is" : `${changes.mediaPaths} media files are`} kept at another path. Nova follows ${one ? "it" : "them"}.`,
		);
	}
	if (changes.columnFields.length > 0) {
		const one = changes.columnFields.length === 1;
		lines.push(
			`In CommCare HQ, the case ${one ? "list" : "lists"} of ${quoted(changes.columnFields)} now ${one ? "names" : "name"} a column's property another way. Nova follows ${one ? "it" : "them"}, so each column's translations stay where they are.`,
		);
	}
	return lines;
}

/**
 * The line a review says where CommCare HQ no longer lists the Android apps
 * the app needs because the project space lost App Dependencies
 * (`androidAppDependencies.ts::androidRequirementsPrivilegeLost`). Nova keeps
 * them, since no one chose to remove them.
 */
export const ANDROID_APPS_PRIVILEGE_LOST_LINE =
	"CommCare HQ no longer lists the Android apps workers need, as it does when a project space loses App Dependencies. Nova keeps them in the app, since no one chose to remove them.";

/** The panel's lead over what the next publish changes, each line the register's own sentence. */
export const NEXT_PUBLISH_LEAD =
	"Nova writes a few things its own way, so your next publish changes these in CommCare HQ:";

// ── Nothing to bring in ──────────────────────────────────────────────

/** The line where there is nothing to bring in, by why. */
export function nothingToBringInLine(
	reason: "unchanged" | "reads-the-same" | "already-here",
	since: string,
): string {
	switch (reason) {
		case "unchanged":
			return `Nothing in this app has changed in CommCare HQ since ${since}.`;
		case "reads-the-same":
			return `CommCare HQ saved this app since ${since}, and Nova reads it as the same app. There's nothing to bring in.`;
		case "already-here":
			return `What changed in CommCare HQ since ${since} is already in this app. There's nothing to bring in.`;
		default: {
			const unplaced: never = reason;
			return unplaced;
		}
	}
}

/** On the card, after `nothingToBringInLine`. */
export const NEXT_PUBLISH_GOES_AHEAD =
	"Your next publish here goes ahead as usual.";

// ── Something Nova can't hold ────────────────────────────────────────

export const CANNOT_BRING_IN_HEADING =
	"Nova can't bring in CommCare HQ's version";

/** The lead over an account of `n` findings Nova can't hold. */
export function cannotBringInLead(n: number): string {
	const found =
		n === 1 ? "1 thing it can't hold" : `${count(n)} things it can't hold`;
	return `Nova read what changed and found ${found}, so it brought nothing in. Taking part of an app would lose the rest at the next publish. Here is each one, with what you can do about it.`;
}

/** The lead where CommCare HQ's version is larger than Nova brings in, so Nova read nothing. */
export const CANNOT_BRING_IN_TOO_LARGE_LEAD =
	"CommCare HQ's version of this app is larger than Nova brings in, so Nova brought nothing in.";

/** The lead where reading CommCare HQ's version takes more work than Nova gives one app, so
 *  Nova stopped reading it. */
export const CANNOT_BRING_IN_TOO_INTRICATE_LEAD =
	"CommCare HQ's version of this app takes more checking than Nova gives one app, so Nova brought nothing in.";

/** The lead over an account whose one finding is a limit of Nova's own at the app: its size or
 *  the work of reading it. */
export function novaLimitLead(code: "too-large" | "too-intricate"): string {
	return code === "too-large"
		? CANNOT_BRING_IN_TOO_LARGE_LEAD
		: CANNOT_BRING_IN_TOO_INTRICATE_LEAD;
}

/** Under the account of what Nova can't hold, above the two choices that stay as they are. */
export const CANNOT_BRING_IN_OTHER_WAYS =
	"You can also publish over CommCare HQ's version, which removes these from CommCare HQ, or stop publishing here.";

// ── After it is brought in ───────────────────────────────────────────

/** The panel's status line once the changes are in. `discarded`: changes made in Nova were removed. */
export function broughtInLine(discarded: boolean): string {
	return discarded
		? "This app now holds CommCare HQ's version. The changes listed under Nova were removed."
		: "CommCare HQ's changes are in this app now.";
}

/** Under the project space's plan line in the publish dialog, once the changes are in. */
export function nothingNewToPublishLine(domain: string): string {
	return `There's nothing new to publish to “${domain}” yet.`;
}

/**
 * In place of `nothingNewToPublishLine` where the next publish there still
 * changes something Nova writes its own way, which the review step lists.
 */
export function nextPublishChangesLine(domain: string): string {
	return `Your next publish to “${domain}” changes a few things Nova writes its own way. The next step lists them.`;
}

// ── Stops ────────────────────────────────────────────────────────────

/** Shown in place of the parts of a change whose baseline Nova could not read. */
export const BASELINE_UNKNOWN_SENTENCE =
	"Nova couldn't confirm what its last publish left here, so it can't tell whether anything changed.";

/** `BASELINE_UNKNOWN_SENTENCE`, said against what the change is measured against. */
export function baselineUnknownSentence(
	since: DriftReference,
	options?: DriftDateOptions,
): string {
	switch (since.kind) {
		case "published":
			return BASELINE_UNKNOWN_SENTENCE;
		case "brought-in":
			return `Nova couldn't confirm what CommCare HQ held when it brought this app in on ${driftDate(since.at, options)}, so it can't tell whether anything changed.`;
		case "changes-brought-in":
			return "Nova couldn't confirm what CommCare HQ held when it last brought in changes from it, so it can't tell whether anything changed.";
		default: {
			const unplaced: never = since;
			return unplaced;
		}
	}
}

export const REQUIRED_FIRST_PUBLISH_RECOVERY =
	"A Project admin or owner can choose Stop publishing here for this project space. Once any publish in progress finishes, you can bring this HQ app in as a new Nova app. You can also publish the current Nova app to a different project space.";

const AFTER_NEXT_PUBLISH =
	"Nova can bring in changes made in CommCare HQ after your next publish here.";

/** What an unavailable review's line reads: the project space and what the change is measured against. */
export interface HqChangesLineContext {
	readonly requiresReview?: true;
	readonly domain: string;
	readonly since: DriftReference;
	readonly options?: DriftDateOptions;
}

/**
 * Why Nova can't bring in CommCare HQ's changes there. `not-published`,
 * `publishing-stopped`, `app-deleted` and `hq-app-taken` say nothing there is
 * this app's (never published there, publishing there stopped, the app is in
 * recently deleted, or another Nova app took its CommCare HQ app while it
 * was); the rest say why Nova can't tell CommCare HQ's changes from this
 * app's.
 */
export function hqChangesUnavailableLine(
	reason: HqChangesUnavailable,
	context: HqChangesLineContext,
): string {
	const { domain } = context;
	const since = sincePhrase(context.since, domain, context.options);
	const next = context.requiresReview
		? REQUIRED_FIRST_PUBLISH_RECOVERY
		: AFTER_NEXT_PUBLISH;
	const otherWays = context.requiresReview
		? REQUIRED_FIRST_PUBLISH_RECOVERY
		: "You can publish over the change, or stop publishing here.";
	switch (reason) {
		case "not-published":
			return `Nova hasn't published this app to “${domain}”, so there's nothing there to bring in. Publishing there makes a new app.`;
		case "publishing-stopped":
			return hqChangesPublishingStoppedLine(domain);
		case "app-deleted":
			return `This app is in recently deleted, so there's nothing in “${domain}” to bring in to it. Once it's restored, you can check again.`;
		case "hq-app-taken":
			return `Another Nova app took this app's app in “${domain}” while this app was in recently deleted, so there's nothing there to bring in. You can publish there again. Nova updates that app if no other Nova app publishes to it by then, and makes a new one beside it otherwise.`;
		case "no-reference":
			return `Nova can't tell CommCare HQ's changes from this app's here, because its record of the last publish to “${domain}” doesn't hold what that takes. ${next}`;
		case "baseline-unread":
			return `${baselineUnknownSentence(context.since, context.options)} ${next}`;
		case "base-needs-project-data":
			return `This Project's lookup tables or organization changed since ${since}, so Nova can't read its own record of what it left in “${domain}”, and can't tell what changed there. ${next}`;
		case "base-unreadable":
			return `Nova couldn't read its own record of what it left in “${domain}”, so it can't tell what changed there. That's Nova's to fix, and Nova has reported it. ${next}`;
		case "base-too-large":
			return `Nova's record of what it left in “${domain}” is larger than Nova compares, so it can't tell what changed there. That limit is Nova's, not the app's. ${otherWays}`;
		case "comparison-too-intricate":
			return `Comparing CommCare HQ's version with what Nova left in “${domain}” takes more checking than Nova gives one app, so it can't tell what changed there. That limit is Nova's, not the app's. ${otherWays}`;
		case "nova-updated":
			return `Nova updated how this app is stored since ${since}, so it can't tell this app's changes from CommCare HQ's here. ${next}`;
		case "nova-defect":
			return `Nova read what changed in CommCare HQ and couldn't fit it to this app, so it changed nothing. That's Nova's to fix, and Nova has reported it. ${context.requiresReview ? "You can check again later. " + REQUIRED_FIRST_PUBLISH_RECOVERY : "You can check again later, publish over the change, or stop publishing here."}`;
		case "app-moved":
			return `This app moved to another Project after it was changed in Nova and before it was published to “${domain}” again, so Nova can't tell this app's changes from CommCare HQ's here. ${next}`;
		default: {
			const unplaced: never = reason;
			return unplaced;
		}
	}
}

/**
 * A change Nova names and can't take. `runs` is where the app
 * runs and where CommCare HQ's version runs, for `runs-elsewhere`; each
 * platform is named as a sentence names one ("in Web Apps", "on Android").
 */
export function hqChangesHeldLine(
	reason: HqChangeHeld,
	runs: {
		readonly app: readonly Platform[];
		readonly hq: readonly Platform[];
	} | null,
	requiresReview = false,
	translation?: import("./hqChangesKinds").HqSourceTranslationRecovery,
): string {
	const next = requiresReview
		? " and check again."
		: " and check again, or publish over the change.";
	switch (reason) {
		case "stale-source-translation": {
			const phrase = translation
				? `“${translation.breadcrumb.join(" › ")}” in ${translation.languageName}`
				: "a phrase in the new source language";
			return `CommCare HQ now uses ${translation?.languageName ?? "another language"} for the original wording. In Languages, you can keep, replace or clear the out-of-date translation of ${phrase}, then check again.`;
		}
		case "runs-elsewhere": {
			const where =
				runs === null
					? ""
					: ` This app runs ${namesInWords(runs.app.map(inPlatform))}, and what changed in CommCare HQ runs only ${namesInWords(runs.hq.map(inPlatform))}.`;
			return `CommCare HQ's version doesn't run everywhere this app does.${where} You can change where this app runs in App settings${next}`;
		}
		default: {
			const unplaced: never = reason;
			return unplaced;
		}
	}
}

/** The gate refusal's first sentence; each finding's own sentence follows it. */
export const HQ_CHANGES_GATE_LEAD =
	"Bringing these changes in would leave something in this app that no longer works, so Nova changed nothing.";
/** The gate refusal's last sentence, after the findings. */
export const HQ_CHANGES_GATE_NEXT =
	"You can change that in Nova and check again, or publish over the change.";

/**
 * The app or CommCare HQ moved while the person read the lists.
 * `editedBy` is another member whose edit moved the app, where that is
 * what changed.
 */
export function hqChangesMovedLine(editedBy: string | null): string {
	const lead =
		"CommCare HQ's copy or this app changed while you were reading, so here is the list as it stands now.";
	return editedBy === null
		? lead
		: `${lead} ${editedBy} is editing this app. You can bring the changes in when they pause.`;
}

/**
 * In place of `hqChangesMovedLine` where a bring-in found something other than a list to show
 * (CommCare HQ couldn't be read again, or what it holds can't be brought in):
 * the request took nothing, and the panel's new state says why.
 */
export const HQ_CHANGES_NOTHING_TAKEN_LINE = "Nova brought nothing in.";

/** A bring-in whose request left a table that asks its choice unanswered. */
export const HQ_CHANGES_TABLE_CHOICE_MISSING =
	"A lookup table these changes read needs your choice before Nova can bring them in. You can choose what to do with it in the list of changes.";

/** A bring-in whose request sent an answer the review does not offer. */
export const HQ_CHANGES_TABLE_CHOICE_NOT_OFFERED =
	"One of the choices sent isn't one this list of changes offers. The list may have changed, so you can check again and choose again.";

/** A bring-in by a member who can no longer add files to the Project. */
export const HQ_CHANGES_FILES_NOT_PERMITTED =
	"You don't have edit access to this Project's files any more, so Nova brought nothing in. One of its admins can give you edit access.";

/**
 * `publishing-stopped`: a review or a bring-in of a project space where publishing stopped,
 * before it was asked or while it ran.
 */
export function hqChangesPublishingStoppedLine(domain: string): string {
	return `Nova stopped publishing this app to “${domain}”, so there's nothing there to bring in. Publishing there again makes a new app.`;
}

/** A review whose request ended with no answer: the connection, a deploy or the instance ended it. */
export const HQ_CHANGES_REVIEW_LOST_LINE =
	"Nova lost its connection while reading what changed in CommCare HQ, and nothing in this app changed. You can check again.";

/** A bring-in whose request ended with no answer, which may or may not have landed. */
export const HQ_CHANGES_BRING_IN_LOST_LINE =
	"Nova lost its connection while bringing the changes in. You can check again to see where things stand.";

/** A review or a bring-in that met something on Nova's side that is no answer, which Nova logged. */
export const HQ_CHANGES_FAILED_LINE =
	"Something went wrong on Nova's side, and Nova has reported it. You can check again to see where things stand.";

/** A review or a bring-in refused because the member can no longer edit the app. */
export const HQ_CHANGES_NO_EDIT_ACCESS_LINE =
	"You don't have edit access to this app any more, so Nova changed nothing. One of the Project's admins can give you edit access.";

/** A review or a bring-in refused because the member's session ended. */
export const HQ_CHANGES_SIGNED_OUT_LINE =
	"You're signed out of Nova, so it changed nothing. You can sign in again and then check again.";

// ── The Publishing card and the builder's header ─────────────────────

/**
 * Refresh from CommCare HQ's sentence where it found a change made in
 * CommCare HQ. `date` is the kept list's date, formatted for the reader.
 */
export function keptChangedInHqLine(date: string): string {
	return `CommCare HQ saved this app since Nova last read it, so these stay as of ${date}.`;
}

/** The button beside `keptChangedInHqLine`'s sentence. */
export const SEE_WHAT_CHANGED_ACTION = "See what changed";
/**
 * On a Publishing card whose project space the check when the builder opens
 * found changed, beside `SEE_WHAT_CHANGED_ACTION`, so the header's
 * `SEE_WHAT_CHANGED_IN_HQ_ACTION` lands on a card that says so.
 */
export function hqChangedFoundLine(since: string): string {
	return `Something in this app changed in CommCare HQ since ${since}.`;
}
/** The builder header's button where opening the app found a change. */
export const SEE_WHAT_CHANGED_IN_HQ_ACTION = "See what changed in CommCare HQ";
/** The card's dialog title. */
export const HQ_CHANGES_DIALOG_TITLE = "Changes in CommCare HQ";

// ── The publish dialog's headline ────────────────────────────────────

/**
 * The `hq_changed` refusal's headline where the app's change can be brought
 * in. It names no way on, because the panel under it does, and it leaves
 * out the sentence about a save that changed no value, since such a save
 * goes ahead by itself. `hasOtherChanges`: the refusal also lists a lookup
 * table or a place.
 */
export function hqChangedBringInMessage(
	since: DriftReference,
	hasOtherChanges: boolean,
	options?: DriftDateOptions,
): string {
	const headline = bringInHeadline(since, options);
	return hasOtherChanges
		? `${headline} The lookup tables and places listed below keep their own choice.`
		: headline;
}

function bringInHeadline(
	since: DriftReference,
	options: DriftDateOptions | undefined,
): string {
	switch (since.kind) {
		case "published":
			return "Something in this app changed in CommCare HQ since Nova last published it, so Nova stopped before sending anything. Here's what changed.";
		case "brought-in":
			return `Something in this app changed in CommCare HQ since Nova brought it in on ${driftDate(since.at, options)}, so Nova stopped before sending anything. Here's what changed.`;
		case "changes-brought-in":
			return "Something in this app changed in CommCare HQ since Nova last brought in changes from it, so Nova stopped before sending anything. Here's what changed.";
		default: {
			const unplaced: never = since;
			return unplaced;
		}
	}
}

/**
 * The publish dialog's heading over a list of kind `next-publish`: what a
 * publish changes after changes made in CommCare HQ were brought in, or
 * read and found equal, where HQ's version holds things Nova writes its
 * own way.
 */
export const NEXT_PUBLISH_HEADING = "What this publish changes in CommCare HQ";

/** The publish dialog's lead under `NEXT_PUBLISH_HEADING`. */
export const NEXT_PUBLISH_DIALOG_LEAD =
	"CommCare HQ's version holds a few things Nova writes its own way. This publish changes them there.";

/**
 * The notice every other open tab shows once its reload after a bring-in of
 * changes made in CommCare HQ has landed. `name` is the member who chose it,
 * or `null` where the tab does not hold that member. The reload carries who
 * and which batch, and not whether anything was removed, so this says
 * nothing of that.
 */
export function hqChangesBroughtInToast(name: string | null): string {
	return `${name ?? "Someone in this Project"} brought in changes from CommCare HQ, so this app now shows the latest. Edits you hadn't saved yet are kept where they still fit.`;
}
