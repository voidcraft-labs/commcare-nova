// Geopoint text normalization shared by on-device distance evaluation and the
// runtime CSQL query builder. Stored case properties and search centers both
// accept CommCare's two-part `lat lon` and four-part
// `lat lon altitude accuracy` forms. HQ and JavaRosa both admit literal `NaN`
// for altitude/accuracy, while latitude/longitude must stay numeric.

// JavaRosa's `double()` accepts ordinary decimal spellings but not a leading
// plus sign or exponent notation. Latitude/longitude use that exact shared
// subset so static CSQL, Preview SQL, and on-device range checks agree.
export const GEOPOINT_NUMBER_PATTERN = String.raw`-?(?:[0-9]{1,32}(?:\.[0-9]{0,32})?|\.[0-9]{1,32})`;
const GEOPOINT_METADATA_NUMBER_PATTERN = String.raw`[+-]?(?:[0-9]{1,32}(?:\.[0-9]{0,32})?|\.[0-9]{1,32})(?:[eE][+-]?[0-9]{1,3})?`;
const GEOPOINT_METADATA_PATTERN = `(?:${GEOPOINT_METADATA_NUMBER_PATTERN}|NaN)`;
export const GEOPOINT_PROPERTY_PATTERN = `^${GEOPOINT_NUMBER_PATTERN} ${GEOPOINT_NUMBER_PATTERN}(?: ${GEOPOINT_METADATA_PATTERN} ${GEOPOINT_METADATA_PATTERN})?$`;
export const GEOPOINT_CENTER_PATTERN = `^${GEOPOINT_NUMBER_PATTERN} ${GEOPOINT_NUMBER_PATTERN}(?: ${GEOPOINT_METADATA_PATTERN} ${GEOPOINT_METADATA_PATTERN})?$`;
export const GEOPOINT_RAW_CENTER_PATTERN = `^(?:\\s*${GEOPOINT_NUMBER_PATTERN}\\s+${GEOPOINT_NUMBER_PATTERN}(?:\\s+${GEOPOINT_METADATA_PATTERN}\\s+${GEOPOINT_METADATA_PATTERN})?\\s*|\\s*${GEOPOINT_NUMBER_PATTERN}\\s*,\\s*${GEOPOINT_NUMBER_PATTERN}\\s*)$`;

export function normalizeStaticGeopoint(value: string): string {
	return value.replaceAll(",", " ").trim().split(/\s+/).join(" ");
}

const centerRegex = new RegExp(GEOPOINT_CENTER_PATTERN);
const rawCenterRegex = new RegExp(
	GEOPOINT_RAW_CENTER_PATTERN.replaceAll("\\s", "[ \\t\\n\\x0B\\f\\r]"),
);

/** HQ's flexible search-center contract after Nova's input normalization. */
export function isValidStaticGeopointCenter(value: string): boolean {
	if (!rawCenterRegex.test(value)) return false;
	const normalized = normalizeStaticGeopoint(value);
	if (!centerRegex.test(normalized)) return false;
	const [latitude, longitude] = normalized.split(" ").map(Number);
	return (
		Number.isFinite(latitude) &&
		latitude >= -90 &&
		latitude <= 90 &&
		Number.isFinite(longitude) &&
		longitude >= -180 &&
		longitude <= 180
	);
}
