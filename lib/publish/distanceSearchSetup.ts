/**
 * What a person sets up on CommCare HQ so the app's searches can find cases
 * by distance there: each case property a search measures distance on needs
 * the GPS data type in the project space's Data Dictionary, which only a
 * signed-in person can set. `lib/commcare/distanceSearches.ts` derives the
 * properties and holds the HQ chain behind the requirement.
 *
 * The one copy of this guidance, read by the setup artifact's
 * `distance-search` section and the HQ import file's guide. Safe for
 * browser, HTTP and MCP consumers.
 */

/** One case property a search measures distance on, as the guidance names it. */
export interface DistanceSearchSetupProperty {
	readonly caseType: string;
	readonly property: string;
	/** The name of each menu whose search reads it, in menu order. */
	readonly moduleNames: readonly string[];
}

export const DISTANCE_SEARCH_SETUP_TITLE = "Finding cases by distance";

/** Why the step exists, with the project space's name where there is one. */
export function distanceSearchSetupSummary(space: string | null): string {
	return `This app's searches find cases by how far away they are. CommCare HQ's search measures distance only on a case property its Data Dictionary marks as GPS, so ${space === null ? "in your project space" : `on “${space}”`} each property below needs that data type. Until it has it, those searches find no cases there.`;
}

/** The step for one property. */
export function distanceSearchSetupStep(
	entry: DistanceSearchSetupProperty,
): string {
	return `In the “${entry.caseType}” case type, set the data type of “${entry.property}” to GPS.`;
}

/** "“A”", "“A” and “B”", "“A”, “B” and “C”". */
function quotedList(names: readonly string[]): string {
	const quoted = names.map((name) => `“${name}”`);
	if (quoted.length <= 1) return quoted[0] ?? "";
	return `${quoted.slice(0, -1).join(", ")} and ${quoted[quoted.length - 1]}`;
}

/** Which searches read the property. */
export function distanceSearchSetupReaders(
	entry: DistanceSearchSetupProperty,
): string {
	const one = entry.moduleNames.length === 1;
	return `${one ? "The search" : "The searches"} in ${quotedList(entry.moduleNames)} ${one ? "measures" : "measure"} distance on it.`;
}

/**
 * What a person should know beside the steps. The plans are the current
 * plans whose feature list carries both `DATA_DICTIONARY` (the pillow's own
 * check) and `DATA_DICT_TYPES` (the page's Data Type column), which
 * `accounting/bootstrap/features.py` gives first to `advanced_v0`.
 */
export const DISTANCE_SEARCH_SETUP_CAVEATS: readonly string[] = [
	"The Data Dictionary and its data types come with the Advanced and Enterprise plans. On other plans, CommCare HQ's search can't find these cases by distance.",
	"If a property isn't listed under its case type, you can add it there. CommCare HQ lists each property an app's forms save once the app is on the project space.",
	"CommCare HQ reads the data type as it saves each case, so a case saved before you set it is found by distance once it next changes.",
	"The property a project space keeps case locations in, “gps_point” unless its geospatial settings name another, is found by distance without this. Setting it to GPS does no harm.",
	"Nova's preview finds these cases by distance whatever their type, and CommCare HQ only lets a signed-in person change its Data Dictionary, so Nova can't set or check this for you.",
];
