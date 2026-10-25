// Shared location-picker value boundary for Preview UI and form evaluation.
//
// Pure conversions between a geopoint field's wire value and a typed
// coordinate. The wire value is CommCare's space-separated
// "lat lon alt accuracy" string (see `GEOPOINT_PATTERN` in
// `lib/domain/expression/jsonSchema.ts`): exactly four decimals, or
// empty. The picker UI works in the typed `GeoPoint` shape and only
// touches the string at the engine boundary, so all the parsing /
// formatting lives here where it can be unit-tested without a DOM.
//
// `parse` is deliberately lenient (accepts a bare "lat lon" so a
// hand-authored `default_value` still centers the map) while `format`
// is strict (always emits four tokens) so every value we commit back
// satisfies the wire pattern.

import { openJdk17DoubleToString } from "@/lib/domain/expression/openJdk17DoubleString";

/** A decoded geopoint. `alt`/`accuracy` are metres; both are 0 for a
 *  map-picked point (no sensor reading) and real for device geolocation. */
export interface GeoPoint {
	readonly lat: number;
	readonly lon: number;
	readonly alt: number;
	readonly accuracy: number;
}

const LAT_MIN = -90;
const LAT_MAX = 90;
const LON_MIN = -180;
const LON_MAX = 180;

/** True for a finite latitude inside [-90, 90]. */
export function isValidLat(lat: number): boolean {
	return Number.isFinite(lat) && lat >= LAT_MIN && lat <= LAT_MAX;
}

/** True for a finite longitude inside [-180, 180]. */
export function isValidLon(lon: number): boolean {
	return Number.isFinite(lon) && lon >= LON_MIN && lon <= LON_MAX;
}

/**
 * Decode a wire geopoint string into a `GeoPoint`, or `null` when it
 * can't be read as a coordinate.
 *
 * Accepts two or more whitespace-separated numeric tokens; latitude and
 * longitude must parse and fall in range. Altitude/accuracy default to 0
 * when absent (the two-token case a hand-authored default might use).
 * An empty / blank string, an out-of-range lat or lon, or a non-numeric
 * first-two token yields `null`: the caller treats that as "no value".
 */
export function parseGeopoint(raw: string | undefined | null): GeoPoint | null {
	if (!raw) return null;
	const tokens = raw.trim().split(/\s+/);
	if (tokens.length < 2) return null;

	const lat = Number(tokens[0]);
	const lon = Number(tokens[1]);
	if (!isValidLat(lat) || !isValidLon(lon)) return null;

	// Altitude / accuracy are best-effort: a non-numeric or absent token
	// collapses to 0 rather than failing the whole parse, since the
	// coordinate is the part the map actually needs.
	const alt = tokens.length > 2 ? Number(tokens[2]) : 0;
	const accuracy = tokens.length > 3 ? Number(tokens[3]) : 0;

	return {
		lat,
		lon,
		alt: Number.isFinite(alt) ? alt : 0,
		accuracy: Number.isFinite(accuracy) ? accuracy : 0,
	};
}

/**
 * Encode a `GeoPoint` into the wire string as CommCare stores it. Always
 * emits four tokens so the result matches `GEOPOINT_PATTERN`. Latitude and
 * longitude are kept as given, altitude and accuracy floored to two decimals
 * (`GeoPointData.java::fillArray`, whose `roundDecimalUp` is
 * `Math.floor(x * 100) / 100`), and each of the four printed with Java's
 * `Double.toString` (Formplayer
 * `JsonActionUtils.java::convertTouchFormsGeoPointString`, Core
 * `GeoPointData.java::getDisplayText`), so a map-picked point reads
 * `40.0 -74.0 0.0 0.0` and a tiny coordinate `1.0E-4`. One spelling serves
 * both platforms. The caller is responsible for passing an in-range
 * coordinate: `format` does not re-validate, mirroring the engine's "value
 * in, string out" contract.
 */
export function formatGeopoint(point: GeoPoint): string {
	const finite = (value: number) => (Number.isFinite(value) ? value : 0);
	const hundredths = (value: number) => Math.floor(finite(value) * 100) / 100;
	return [
		finite(point.lat),
		finite(point.lon),
		hundredths(point.alt),
		hundredths(point.accuracy),
	]
		.map(openJdk17DoubleToString)
		.join(" ");
}

/** Human-readable "lat, lon" for the summary card, rounded for display
 *  only. Returns `null` for an unparseable value. */
export function formatLatLonLabel(point: GeoPoint): string {
	return `${point.lat.toFixed(5)}, ${point.lon.toFixed(5)}`;
}

/**
 * One coordinate as Android's location question shows an answer: degrees,
 * minutes and whole seconds behind the hemisphere letter, `N 1°16'59"`
 * (`GeoUtils.java::formatGps`). Android cuts each part from Java's
 * `Double.toString` at the decimal point rather than rounding, so this does
 * the same over the same spelling.
 */
export function androidCoordinateText(
	coordinate: number,
	axis: "lat" | "lon",
): string {
	const wholePart = (spelled: string) => spelled.slice(0, spelled.indexOf("."));
	const fractionPart = (spelled: string) =>
		Number(`0.${spelled.slice(spelled.indexOf(".") + 1)}`);
	const location = openJdk17DoubleToString(coordinate);
	const degrees = wholePart(location);
	const minutesSpelled = openJdk17DoubleToString(fractionPart(location) * 60);
	const secondsSpelled = openJdk17DoubleToString(
		fractionPart(minutesSpelled) * 60,
	);
	const south = degrees.startsWith("-");
	const hemisphere = axis === "lon" ? (south ? "W" : "E") : south ? "S" : "N";
	return `${hemisphere} ${degrees.replace("-", "")}°${wholePart(minutesSpelled)}'${wholePart(secondsSpelled)}"`;
}

/** Metres as Android's location question shows them: at most two decimals,
 *  no trailing zeros (`GeoPointWidget.java::truncateDouble`, `#.##`). */
export function androidMetersText(meters: number): string {
	return String(Math.round(meters * 100) / 100);
}
