import { recordFromEntries } from "@/lib/domain/records";
import { locationWireValue } from "./locationMetadata";
import type { HqLocationPush } from "./locations";

/** locations/util.py::validate_site_code lowercases before Python’s Unicode
 * character check. Existing exact codes can be preserved by omitting both
 * name and site_code during an update. */
export function writableSiteCode(code: string): boolean {
	return code === code.toLowerCase() && /^[-_\p{L}\p{N}]+(?:\n)?$/u.test(code);
}

export function observablePlaceMetadata(
	values: Readonly<Record<string, string>>,
	source?: Readonly<Record<string, string>>,
): Record<string, string> {
	return source
		? recordFromEntries(Object.entries(source))
		: recordFromEntries(
				Object.entries(values).map(([slug, value]) => [
					slug,
					JSON.stringify(value),
				]),
			);
}

type Content = {
	name: string;
	siteCode: string;
	levelCode: string;
	latitude: string | null;
	longitude: string | null;
	source?: {
		nameIsNull: boolean;
		wire: Readonly<Record<string, string>>;
		latitudeText: string | null;
		longitudeText: string | null;
	};
	rawData?: Readonly<Record<string, string>>;
	stagedWire?: Readonly<Record<string, string>>;
	locationData: Readonly<Record<string, unknown>> | null;
};
type Current = {
	locationId: string;
	name: string;
	siteCode: string;
	parentLocationId: string | null;
	locationTypeCode?: string;
	latitude?: string | null;
	longitude?: string | null;
	values: Readonly<Record<string, unknown>>;
	observation?: { nameIsNull: boolean; wire: Readonly<Record<string, string>> };
};
export function placeDecimal(value: string | null | undefined) {
	if (value == null) return null;
	const [integer, fraction = ""] = value.split(".");
	const unsigned = integer.replace(/^-?0+(?=\d)/, "").replace(/^-/, "") || "0";
	const digits = fraction.replace(/0+$/, "");
	return (
		(integer.startsWith("-") && (unsigned !== "0" || digits) ? "-" : "") +
		unsigned +
		(digits ? "." + digits : "")
	);
}

/** Returns no PATCH when the destination already holds exactly these values.
 * Omitting an unchanged location_data also preserves unobservable dictionary
 * insertion order and avoids running unrelated target field validators. */
export function placePatch(
	place: Content,
	current: Current | undefined,
	parentId: string | null,
): HqLocationPush | null {
	const sameName =
		current &&
		current.name === place.name &&
		(current.observation?.nameIsNull ?? false) ===
			(place.source?.nameIsNull ?? false);
	const data = place.rawData
		? recordFromEntries(
				Object.entries(place.rawData).map(([key, value]) => [
					key,
					locationWireValue(value),
				]),
			)
		: current?.observation
			? null
			: place.locationData;
	const changes: HqLocationPush = {
		...(!sameName && { name: place.source?.nameIsNull ? null : place.name }),
		...((!sameName || current?.siteCode !== place.siteCode) && {
			siteCode: place.siteCode,
		}),
		...((!current ||
			current.locationTypeCode !== place.levelCode ||
			(parentId && parentId !== current.parentLocationId)) && {
			locationTypeCode: place.levelCode,
		}),
		...(parentId && current?.parentLocationId !== parentId
			? { parentLocationId: parentId }
			: {}),
		...(placeDecimal(current?.latitude) !== placeDecimal(place.latitude) && {
			latitude: place.latitude,
		}),
		...(placeDecimal(current?.longitude) !== placeDecimal(place.longitude) && {
			longitude: place.longitude,
		}),
		...(data !== null && { locationData: data }),
	};
	return current && !Object.keys(changes).length
		? null
		: { ...(current && { locationId: current.locationId }), ...changes };
}

export function placeContentMatches(
	place: Content,
	current: Current,
	parentId: string | null,
	ownedKeys: readonly string[],
	desiredWire: Readonly<Record<string, string>>,
): boolean {
	if (!current.observation) return false;
	return (
		current.name === place.name &&
		current.siteCode === place.siteCode &&
		current.locationTypeCode === place.levelCode &&
		current.parentLocationId === parentId &&
		current.observation.nameIsNull === (place.source?.nameIsNull ?? false) &&
		placeDecimal(current.latitude) === placeDecimal(place.latitude) &&
		placeDecimal(current.longitude) === placeDecimal(place.longitude) &&
		(!place.source ||
			(current.latitude === place.source.latitudeText &&
				current.longitude === place.source.longitudeText)) &&
		ownedKeys.every(
			(key) => current.observation?.wire[key] === desiredWire[key],
		) &&
		exactBagMatches(place.rawData ?? place.stagedWire, current.observation.wire)
	);
}

function exactBagMatches(
	expected: Readonly<Record<string, string>> | undefined,
	actual: Readonly<Record<string, string>>,
) {
	return (
		!expected ||
		(Object.keys(expected).length === Object.keys(actual).length &&
			Object.keys(expected).every(
				(key) => Object.hasOwn(actual, key) && actual[key] === expected[key],
			))
	);
}
