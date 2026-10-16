/**
 * The drift verdict, and every sentence a person reads about a change made
 * in CommCare HQ since Nova last published there.
 *
 * Preflight collects one `DeploymentRemoteChange` per resource whose HQ
 * state is not its baseline's, and `decideRemoteChanges` lets the publish
 * proceed only when a person named every one of them back with the exact
 * state they were shown. Pure: the parts come typed from
 * `hqSourceBaseline.ts` and `hqResourceBaseline.ts`, and are put into words
 * here and nowhere else.
 */

import type { LookupChangePart, PlaceChangePart } from "./hqResourceBaseline";
import type { AppChangePart } from "./hqSourceBaseline";
import type { DeploymentRemoteChange, RemoteChangeDiscard } from "./types";

/** The most lines one change lists; past it the last line counts the rest. */
const MAX_PART_LINES = 20;

/** The `hq_changed` refusal's message at preflight. */
export const HQ_CHANGED_MESSAGE =
	"Something this app publishes isn't the same in CommCare HQ as when Nova last published it, so Nova stopped before sending anything. A save in CommCare HQ can show up here even when it changed no value. You can publish over what's listed below, which replaces it with this app's version.";

/** The `hq_changed` refusal's message when CommCare HQ's copy moved during the resource push. */
export const HQ_CHANGED_DURING_PUSH_MESSAGE =
	"CommCare HQ's copy of this app changed while Nova was publishing its lookup tables and places, so Nova stopped before sending the app's content. Publishing again checks what is there now and lists anything that changed.";

/** Shown in place of the parts of a change whose baseline Nova could not read. */
export const BASELINE_UNKNOWN_SENTENCE =
	"Nova couldn't confirm what its last publish left here, so it can't tell whether anything changed.";

/**
 * The note on a lookup table change whose discard replaces a table HQ still
 * holds under that tag and id: a change to its definition or rows, or one
 * whose baseline Nova could not read. HQ's table key holds a description
 * and each field's indexed flag (`fixtures/upload/run_upload.py::table_key`),
 * which no API-key read returns and no workbook carries a description of,
 * so the push makes such a table again without them.
 */
export const LOOKUP_DISCARD_NOTE =
	"If it has a description or indexed fields in CommCare HQ, publishing removes them: CommCare HQ doesn't show those to Nova, and a lookup upload can't carry a description.";

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

/** The `hq-changes` check's detail when changes were compared and none differs. */
export const HQ_CHANGES_NONE_DETAIL =
	"Nothing this app publishes has changed in CommCare HQ since Nova last published it.";

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

/** At most 20 lines; past 20 the last line is "and N more". */
export function boundedParts(lines: readonly string[]): readonly string[] {
	if (lines.length <= MAX_PART_LINES) return lines;
	const shown = lines.slice(0, MAX_PART_LINES - 1);
	return [...shown, `and ${lines.length - shown.length} more`];
}
