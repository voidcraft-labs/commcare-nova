/**
 * What a person reads about changes made in CommCare HQ that Nova can bring
 * in to the app.
 *
 * Client-safe: the publish dialog, MCP and the server's refusal read one
 * text.
 */

import {
	type DriftDateOptions,
	type DriftReference,
	driftDate,
} from "./driftReference";

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
