import {
	isRetiredAuthoringPath,
	type LocationDoc,
	recoverLocation,
	serializePath,
} from "./location";
import {
	formerParentRecovery,
	type PreviousLocationTopology,
} from "./topologyRecovery";
import type { Location } from "./types";

/** Decide a canonical replacement and retain the last valid topology together.
 * A direct navigation cannot inherit the deleted destination's ancestry. */
export function advanceLocationRecovery(
	previous: PreviousLocationTopology | undefined,
	segments: readonly string[],
	location: Location,
	doc: LocationDoc,
): { topology: PreviousLocationTopology | undefined; replacement?: Location } {
	// Retired bookmarks remain unresolved, as on the server route.
	if (isRetiredAuthoringPath(segments)) return { topology: previous };
	const target =
		formerParentRecovery(segments, previous, doc.modules) ??
		recoverLocation(location, doc);
	const canonical = serializePath(target);
	const matches =
		segments.length === canonical.length &&
		segments.every((segment, index) => segment === canonical[index]);
	return {
		topology: { location: target, modules: doc.modules },
		...(target === location && matches ? {} : { replacement: target }),
	};
}
