/**
 * The drift verdict, and every sentence a person reads about a change made
 * in CommCare HQ since Nova last published there, brought the app in, or
 * last brought in changes from it.
 *
 * Preflight collects one `DeploymentRemoteChange` per resource whose HQ
 * state is not its baseline's, and `decideRemoteChanges` lets the publish
 * proceed only when a person named every one of them back with the exact
 * state they were shown. Pure: the parts come typed from
 * `hqSourceBaseline.ts` and `hqResourceBaseline.ts`, and are put into words
 * here and nowhere else.
 */

import {
	type DriftDateOptions,
	type DriftReference,
	driftDate,
} from "@/lib/publish/driftReference";
import { hqChangedBringInMessage } from "@/lib/publish/hqChangesCopy";
import { LOOKUP_DISCARD_NOTE } from "@/lib/publish/managedData";

export { LOOKUP_DISCARD_NOTE } from "@/lib/publish/managedData";

import type { LookupChangePart, PlaceChangePart } from "./hqResourceBaseline";
import type { AppChangePart } from "./hqSourceBaseline";
import type {
	AppBaseline,
	DeploymentRemoteChange,
	DeploymentResource,
	RemoteChangeDiscard,
} from "./types";

/** The most lines one change lists; past it the last line counts the rest. */
const MAX_PART_LINES = 20;

/** The `hq_changed` refusal's message at preflight. */
export const HQ_CHANGED_MESSAGE =
	"Something this app publishes isn't the same in CommCare HQ as when Nova last published it, so Nova stopped before sending anything. A save in CommCare HQ can show up here even when it changed no value. You can publish over what's listed below, which replaces it with this app's version.";

/**
 * The refusal's message where it lists the app, measured against a
 * bring-in, beside a lookup table or a place, measured against a publish.
 */
const HQ_CHANGED_SINCE_READ_MESSAGE =
	"Something this app publishes isn't the same in CommCare HQ as when Nova last read it there, so Nova stopped before sending anything. A save in CommCare HQ can show up here even when it changed no value. You can publish over what's listed below, which replaces it with this app's version.";

/**
 * What the app's change is measured against. `brought-in` where the
 * baseline's origin is `read`, or `unread` over a stored `read`;
 * `changes-brought-in` where it is `changes`, or `unread` over a stored
 * `changes`; `published` for every other baseline and for none.
 *
 * `at` is the app mapping's `adoptedAt`, never the baseline's `observedAt`:
 * a refresh of kept values rewrites a `read` baseline's source and date and
 * keeps its origin, and the app was still brought in when it was. A `read`
 * baseline's live mapping is always the adopted one; were `adoptedAt` null
 * there, `at` is the baseline's `observedAt`, so the function is total.
 * `changes-brought-in` carries no date: it would be the baseline's
 * `observedAt`, which a refresh moves.
 */
export function driftReferenceOf(
	baseline: AppBaseline | null,
	mapping: Pick<DeploymentResource, "adoptedAt"> | null,
): DriftReference {
	if (baseline === null) return { kind: "published" };
	const origin =
		baseline.origin === "unread" ? baseline.storedOrigin : baseline.origin;
	switch (origin) {
		case "read":
			return {
				kind: "brought-in",
				at: mapping?.adoptedAt ?? baseline.observedAt,
			};
		case "changes":
			return { kind: "changes-brought-in" };
		case "create":
		case "push":
		case "cutover":
		case "unread":
			return { kind: "published" };
		default: {
			const unplaced: never = origin;
			return unplaced;
		}
	}
}

/**
 * The `hq_changed` refusal's message at preflight, over the changes it
 * lists in its order. Only the app's change can be measured against
 * anything but a publish, so a `brought-in` date is the app change's.
 * Where the app's change can be brought in, the headline names no way on:
 * the panel under it does.
 */
export function hqChangedMessage(
	changes: readonly Pick<
		DeploymentRemoteChange,
		"since" | "kind" | "canBringIn" | "requiresReview"
	>[],
	options?: DriftDateOptions,
): string {
	if (changes.some((change) => change.requiresReview))
		return "Nova needs a current review of what publishing would change in CommCare HQ.";
	const app = changes.find((change) => change.kind === "app");
	const others = changes.some((change) => change.kind !== "app");
	if (app === undefined) return HQ_CHANGED_MESSAGE;
	if (app.canBringIn) {
		return hqChangedBringInMessage(app.since, others, options);
	}
	const since = app.since;
	switch (since.kind) {
		case "published":
			return HQ_CHANGED_MESSAGE;
		case "brought-in":
			return others
				? HQ_CHANGED_SINCE_READ_MESSAGE
				: `Something in this app isn't the same in CommCare HQ as when Nova brought it in on ${driftDate(since.at, options)}, so Nova stopped before sending anything. A save in CommCare HQ can show up here even when it changed no value. You can publish over what's listed below, which replaces it with this app's version.`;
		case "changes-brought-in":
			return others
				? HQ_CHANGED_SINCE_READ_MESSAGE
				: "Something in this app isn't the same in CommCare HQ as when Nova last brought in changes from it, so Nova stopped before sending anything. A save in CommCare HQ can show up here even when it changed no value. You can publish over what's listed below, which replaces it with this app's version.";
		default: {
			const unplaced: never = since;
			return unplaced;
		}
	}
}

/** The `hq_changed` refusal's message when CommCare HQ's copy moved during the resource push. */
export const HQ_CHANGED_DURING_PUSH_MESSAGE =
	"CommCare HQ's copy of this app changed while Nova was publishing its lookup tables and places, so Nova stopped before sending the app's content. Publishing again checks what is there now and lists anything that changed.";

/**
 * Shown in place of the parts of a change whose baseline Nova could not
 * read. The sentences live with the copy of changes made in CommCare HQ,
 * which says them too and imports nothing of this package.
 */
export {
	BASELINE_UNKNOWN_SENTENCE,
	baselineUnknownSentence,
} from "@/lib/publish/hqChangesCopy";

/**
 * What taking over a lookup table means, said where a person confirms it:
 * the push replaces the table's rows, and HQ makes the table again without
 * a description or indexed fields it held.
 */
export const LOOKUP_ADOPTION_NOTE = `Taking over this table replaces its rows with this app's each time you publish. ${LOOKUP_DISCARD_NOTE}`;

/**
 * The warning when a table Nova pushed with a definition equal to its
 * baseline came back under a new id: HQ made it again.
 */
export function lookupTableMadeAgainWarning(name: string): string {
	return `CommCare HQ made the table ${name} again during this publish. If it had a description or indexed fields there, they are gone: Nova can't read or keep either yet.`;
}

/** The warning when the read after the app's import failed. */
export const APP_READ_BACK_FAILED_WARNING =
	"Nova published the app but couldn't read it back, so the next publish will ask before it writes over what's there.";

/**
 * The warning when CommCare HQ's save counter shows the app changed there
 * between Nova's last read and its import, or between the import and the
 * read back: a save Nova's import may have written over, or one the read
 * back holds beside Nova's own, so the read is no record of what Nova left.
 */
export const APP_CHANGED_DURING_PUBLISH_WARNING =
	"Your publish reached CommCare HQ. CommCare HQ saved the app again, so Nova couldn't confirm whether another change was included. The next publish will ask before it writes over the app.";

/** The warning when publishing there stopped right after the app landed, before its media went. */
export const MEDIA_NOT_SENT_AFTER_STOP_WARNING =
	"Publishing here stopped right after the app landed, so Nova didn't send its pictures and sounds.";

/** A later import was already recorded when HQ answered this publish's import. */
export const MEDIA_NOT_SENT_AFTER_LATER_PUBLISH_WARNING =
	"A later publish has already updated this app in CommCare HQ. Nova left its media in place.";

/**
 * The warning when the app was deleted, or its publisher lost edit, right
 * after the app landed, so its media was not sent.
 */
export const MEDIA_NOT_SENT_AFTER_ACCESS_WARNING =
	"This app was deleted, or you can no longer edit it, right after it landed, so Nova didn't send its pictures and sounds. Once you can edit it again, publishing again sends them.";

/** The warning when a table or place could not be read back after its push. */
export const RESOURCES_READ_BACK_FAILED_WARNING =
	"Nova published this app's lookup tables and places but couldn't read every one of them back, so the next publish will ask before it writes over those.";

/**
 * The line on the landed outcome of a publish that wrote over an app
 * without knowing it unchanged: after a confirmed discard of the app, or
 * over a baseline the cutover recorded.
 */
export const APP_PREVIEW_NOTE =
	"CommCare HQ keeps each form's last check for up to 7 days. If a form had failed that check in CommCare HQ before this publish replaced it, App Preview there can keep refusing to open the app for that long, with the old error. Making a new version in CommCare HQ checks the app afresh. Saving the form once in CommCare HQ's form builder clears the old check, and Nova's next publish then asks before replacing that form.";

/** The `hq-changes` check's detail when every observed change was confirmed. */
export const HQ_CHANGES_CONFIRMED_DETAIL =
	"You chose to publish over what changed in CommCare HQ since Nova last published it.";

/** `HQ_CHANGES_CONFIRMED_DETAIL`, said against the app baseline's reference where the app was compared. */
export function hqChangesConfirmedDetail(
	since: DriftReference,
	options?: DriftDateOptions,
): string {
	switch (since.kind) {
		case "published":
			return HQ_CHANGES_CONFIRMED_DETAIL;
		case "brought-in":
			return `You chose to publish over what changed in CommCare HQ since Nova brought this app in on ${driftDate(since.at, options)}.`;
		case "changes-brought-in":
			return "You chose to publish over what changed in CommCare HQ since Nova last brought in changes from it.";
		default: {
			const unplaced: never = since;
			return unplaced;
		}
	}
}

/** The `hq-changes` check's detail when changes were compared and none differs. */
export const HQ_CHANGES_NONE_DETAIL =
	"Nothing this app publishes has changed in CommCare HQ since Nova last published it.";

/** `HQ_CHANGES_NONE_DETAIL`, said against the app baseline's reference where the app was compared. */
export function hqChangesNoneDetail(
	since: DriftReference,
	options?: DriftDateOptions,
): string {
	switch (since.kind) {
		case "published":
			return HQ_CHANGES_NONE_DETAIL;
		case "brought-in":
			return `Nothing in this app has changed in CommCare HQ since Nova brought it in on ${driftDate(since.at, options)}.`;
		case "changes-brought-in":
			return "Nothing in this app has changed in CommCare HQ since Nova last brought in changes from it.";
		default: {
			const unplaced: never = since;
			return unplaced;
		}
	}
}

/** The `hq-changes` check's detail when there was nothing to compare. */
export const HQ_CHANGES_NOTHING_TO_COMPARE_DETAIL =
	"Nova hasn't published this app's content here before, so there's nothing in CommCare HQ to compare yet.";

/**
 * Proceed only when every observed change is named by a discard whose
 * kind, resource and observed digest all match. A discard that names an
 * older digest is no confirmation of the state HQ holds now, and a discard
 * naming something that did not change is ignored.
 */
export function decideRemoteChanges(input: {
	readonly observed: readonly DeploymentRemoteChange[];
	readonly discards: readonly RemoteChangeDiscard[];
}):
	| {
			readonly proceed: true;
			readonly confirmed: readonly DeploymentRemoteChange[];
	  }
	| {
			readonly proceed: false;
			readonly remoteChanges: readonly DeploymentRemoteChange[];
	  } {
	const confirmed = (change: DeploymentRemoteChange): boolean =>
		!change.requiresReview &&
		input.discards.some(
			(discard) =>
				discard.kind === change.kind &&
				discard.novaResourceId === change.novaResourceId &&
				discard.observedDigest === change.observedDigest,
		);
	if (input.observed.every(confirmed)) {
		return { proceed: true, confirmed: input.observed };
	}
	return { proceed: false, remoteChanges: input.observed };
}

export function describeAppChange(part: AppChangePart): string {
	switch (part.kind) {
		case "form":
			return `The form “${part.name}” in the menu “${part.menuName}”`;
		case "menu":
			return `The menu “${part.name}”`;
		case "menu-list":
			return "The list of menus";
		case "name":
			return "The app's name";
		case "languages":
			return "The app's languages";
		case "settings":
			return "A setting this app writes";
		case "text":
			return "Text this app writes";
		case "unused-media":
			return part.count === 1
				? "A changed file reference that publishing would remove"
				: `${part.count} changed file references that publishing would remove`;
		case "media":
			return part.count === 1
				? "A picture or sound this app publishes"
				: `${part.count} pictures or sounds this app publishes`;
	}
}

export function describeLookupChange(
	part: LookupChangePart,
	novaTag: string,
): string {
	switch (part.kind) {
		case "definition":
			return "Its columns changed in CommCare HQ.";
		case "rows":
			return "Its rows changed in CommCare HQ.";
		case "deleted":
			return "CommCare HQ no longer has this table. Publishing makes it again.";
		case "renamed":
			return `This table now has the tag “${part.tag}” in CommCare HQ. Publishing makes a new table under “${novaTag}” and leaves that one where it is.`;
	}
}

export function describePlaceChange(part: PlaceChangePart): string {
	switch (part.kind) {
		case "name":
			return "Its name changed.";
		case "site-code":
			return "Its site code changed.";
		case "level":
			return "Its level changed.";
		case "parent":
			return "It moved under another place.";
		case "coordinates":
			return "Its coordinates changed.";
		case "information":
			return "Its place information changed.";
		case "missing":
			return "CommCare HQ no longer lists this place. It was archived or deleted there. Publishing makes it again if it was deleted. If it was archived, CommCare HQ refuses the publish while the place stays archived there.";
	}
}

/** File removals precede ordinary differences; the overflow line itself occupies a slot. */
export function fileDisclosureTruncated(
	files: number,
	otherLines: number,
): boolean {
	return files >= MAX_PART_LINES && files + otherLines > MAX_PART_LINES;
}

/** At most 20 lines; past 20 the last line is "and N more". */
export function boundedParts(lines: readonly string[]): readonly string[] {
	if (lines.length <= MAX_PART_LINES) return lines;
	const shown = lines.slice(0, MAX_PART_LINES - 1);
	return [...shown, `and ${lines.length - shown.length} more`];
}
