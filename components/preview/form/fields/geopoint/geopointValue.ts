// components/preview/form/fields/geopoint/geopointValue.ts
//
// Pure conversions between a geopoint field's wire value and a typed
// coordinate. The wire value is CommCare's space-separated
// "lat lon alt accuracy" string (see `GEOPOINT_PATTERN` in
// `lib/domain/predicate/jsonSchema.ts`) — exactly four decimals, or
// empty. The picker UI works in the typed `GeoPoint` shape and only
// touches the string at the engine boundary, so all the parsing /
// formatting lives here where it can be unit-tested without a DOM.
//
// `parse` is deliberately lenient (accepts a bare "lat lon" so a
// hand-authored `default_value` still centers the map) while `format`
// is strict (always emits four tokens) so every value we commit back
// satisfies the wire pattern.

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
 * first-two token yields `null` — the caller treats that as "no value".
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

/** Round to `dp` decimals and drop float noise + trailing zeros, so
 *  `12.3400000001` prints as `12.34` rather than `12.340000`. */
function tidy(value: number, dp: number): string {
	if (!Number.isFinite(value)) return "0";
	return String(Number(value.toFixed(dp)));
}

/**
 * Encode a `GeoPoint` into the wire string. Always emits four tokens so
 * the result matches `GEOPOINT_PATTERN`. Latitude/longitude keep six
 * decimals (~0.1 m); altitude/accuracy keep two. The caller is
 * responsible for passing an in-range coordinate — `format` does not
 * re-validate, mirroring the engine's "value in, string out" contract.
 */
export function formatGeopoint(point: GeoPoint): string {
	const lat = tidy(point.lat, 6);
	const lon = tidy(point.lon, 6);
	const alt = tidy(point.alt, 2);
	const accuracy = tidy(point.accuracy, 2);
	return `${lat} ${lon} ${alt} ${accuracy}`;
}

/** Human-readable "lat, lon" for the summary card, rounded for display
 *  only. Returns `null` for an unparseable value. */
export function formatLatLonLabel(point: GeoPoint): string {
	return `${point.lat.toFixed(5)}, ${point.lon.toFixed(5)}`;
}
