/**
 * Browser ports of CommCare Core's geographic XPath helpers.
 *
 * `distance` follows GeoPointUtils' spherical haversine. Polygon projection
 * deliberately ports the Apache-2.0 `org.gavaghan:geodesy:1.1.3` Vincenty
 * implementation used by Core rather than substituting a different geodesy
 * library whose last-bit results would drift.
 * Vincenty portions derive from Mike Gavaghan's geodesy 1.1.3 (Apache-2.0).
 */

import { openJdk17DoubleToString } from "@/lib/domain/expression/openJdk17DoubleString";
import { parseJavaDouble } from "./javaDouble";
import { javaRosaSplitOnSpaces, javaTrim } from "./javaString";

const EARTH_RADIUS_METERS = 6_371_009;
const WGS84_A = 6_378_137;
const WGS84_F = 1 / 298.257223563;
const WGS84_B = (1 - WGS84_F) * WGS84_A;

interface Point {
	readonly latitude: number;
	readonly longitude: number;
}

interface GeodeticCurve {
	readonly distance: number;
	readonly azimuth: number;
}

export function javaRosaDistance(from: string, to: string): number {
	if (from === "" || to === "") return -1;
	return javaRosaPointDistance(parsePoint(from), parsePoint(to));
}

/** Core's spherical haversine distance in metres between two points given
 *  as numbers (`GeoPointUtils.computeDistanceBetween`), for a caller that
 *  holds coordinates rather than geopoint text. */
export function javaRosaPointDistance(
	start: { readonly latitude: number; readonly longitude: number },
	end: { readonly latitude: number; readonly longitude: number },
): number {
	const lat1 = toRadians(start.latitude);
	const lat2 = toRadians(end.latitude);
	const deltaLongitude = toRadians(start.longitude - end.longitude);
	const havLatitude = hav(lat1 - lat2);
	const havLongitude = hav(deltaLongitude) * Math.cos(lat1) * Math.cos(lat2);
	return (
		EARTH_RADIUS_METERS * 2 * Math.asin(Math.sqrt(havLatitude + havLongitude))
	);
}

export function javaRosaIsPointInsidePolygon(
	pointText: string,
	polygonText: string,
): boolean {
	const { point, polygon } = requiredPointAndPolygon(pointText, polygonText);
	let intersections = 0;
	for (let index = 0; index < polygon.length; index += 1) {
		const a = polygon[index];
		const b = polygon[(index + 1) % polygon.length];
		if (
			(point.latitude === a.latitude && point.longitude === a.longitude) ||
			(point.latitude === b.latitude && point.longitude === b.longitude)
		) {
			return true;
		}
		if (
			a.latitude > point.latitude !== b.latitude > point.latitude &&
			point.longitude <
				((b.longitude - a.longitude) * (point.latitude - a.latitude)) /
					(b.latitude - a.latitude + 1e-10) +
					a.longitude
		) {
			intersections += 1;
		}
	}
	return intersections % 2 === 1;
}

export function javaRosaClosestPointOnPolygon(
	pointText: string,
	polygonText: string,
): string {
	const { point, polygon } = requiredPointAndPolygon(pointText, polygonText);
	let closest: Point | undefined;
	let minimumDistance = Number.MAX_VALUE;
	for (let index = 0; index < polygon.length; index += 1) {
		const projected = projectOntoSegment(
			point,
			polygon[index],
			polygon[(index + 1) % polygon.length],
		);
		const distance = vincentyInverse(point, projected).distance;
		if (distance < minimumDistance) {
			minimumDistance = distance;
			closest = projected;
		}
	}
	if (closest === undefined) throw new Error("Polygon has no boundary.");
	return `${openJdk17DoubleToString(closest.latitude)} ${openJdk17DoubleToString(closest.longitude)}`;
}

function requiredPointAndPolygon(
	pointText: string,
	polygonText: string,
): { readonly point: Point; readonly polygon: readonly Point[] } {
	if (pointText === "" || polygonText === "") {
		throw new Error("Point and polygon coordinates are required.");
	}
	const point = parsePoint(pointText);
	validateCoordinates(point);
	return { point: canonicalize(point), polygon: parsePolygon(polygonText) };
}

function parsePoint(value: string): Point {
	const coordinates = splitPointCoordinates(value);
	if (coordinates.length < 2) {
		throw new Error("Fewer than two coordinates provided.");
	}
	if (coordinates.length > 4) {
		throw new Error("More than four coordinates provided.");
	}
	// GeoPointData.cast parses altitude and accuracy even though these XPath
	// functions subsequently ignore them.
	const parsed = coordinates.map(parseCoordinate);
	const latitude = parsed[0] ?? Number.NaN;
	const longitude = parsed[1] ?? Number.NaN;
	return { latitude, longitude };
}

function parsePolygon(value: string): readonly Point[] {
	const coordinates = splitPolygonCoordinates(value);
	if (coordinates.length % 2 !== 0) {
		throw new Error("A polygon requires latitude/longitude pairs.");
	}
	const polygon: Point[] = [];
	for (let index = 0; index < coordinates.length; index += 2) {
		const point = {
			latitude: parseCoordinate(coordinates[index]),
			longitude: parseCoordinate(coordinates[index + 1]),
		};
		validateCoordinates(point);
		polygon.push(canonicalize(point));
	}
	if (
		polygon.length > 2 &&
		!samePoint(polygon[0], polygon[polygon.length - 1])
	) {
		polygon.push({ ...polygon[0] });
	}
	if (polygon.length < 4) {
		throw new Error("Polygon must have at least three distinct vertices.");
	}
	return polygon;
}

function splitPointCoordinates(value: string): string[] {
	return javaRosaSplitOnSpaces(value);
}

function splitPolygonCoordinates(value: string): string[] {
	if (value === "") return [];
	// Core uses String.split(" ") here, not DataUtil.splitOnSpaces: repeated
	// and leading spaces therefore leave empty tokens, while trailing empties
	// are discarded by Java String.split's default limit.
	const values = value.split(" ");
	while (values.at(-1) === "") values.pop();
	return values;
}

/** A coordinate through Java's `Double.parseDouble`, as `GeoPointData.cast` reads it. */
function parseCoordinate(value: string | undefined): number {
	if (value === undefined || javaTrim(value) === "") {
		throw new Error("Invalid coordinate.");
	}
	const parsed = parseJavaDouble(value);
	if (parsed === undefined) throw new Error("Coordinates must be numeric.");
	return parsed;
}

function validateCoordinates(point: Point): void {
	if (
		point.latitude < -90 ||
		point.latitude > 90 ||
		point.longitude < -180 ||
		point.longitude > 180
	) {
		throw new Error("Invalid coordinates.");
	}
}

function samePoint(a: Point, b: Point): boolean {
	return a.latitude === b.latitude && a.longitude === b.longitude;
}

/** Exact arithmetic/order used by geodesy 1.1.3 GlobalCoordinates. */
function canonicalize(point: Point): Point {
	let latitude = (point.latitude + 180) % 360;
	if (latitude < 0) latitude += 360;
	latitude -= 180;
	let longitude = point.longitude;
	if (latitude > 90) {
		latitude = 180 - latitude;
		longitude += 180;
	} else if (latitude < -90) {
		latitude = -180 - latitude;
		longitude += 180;
	}
	longitude = (longitude + 180) % 360;
	if (longitude <= 0) longitude += 360;
	longitude -= 180;
	return { latitude, longitude };
}

function hav(angle: number): number {
	const sinHalf = Math.sin(angle * 0.5);
	return sinHalf * sinHalf;
}

function projectOntoSegment(point: Point, a: Point, b: Point): Point {
	if (samePoint(a, b)) return a;
	const segment = vincentyInverse(a, b);
	const fromStart = vincentyInverse(a, point);
	const projection =
		fromStart.distance *
		Math.cos(toRadians(fromStart.azimuth - segment.azimuth));
	if (projection <= 0) return a;
	if (projection >= segment.distance) return b;
	return vincentyDirect(a, segment.azimuth, projection);
}

/** Vincenty's inverse formula, ported from geodesy 1.1.3. */
function vincentyInverse(start: Point, end: Point): GeodeticCurve {
	const phi1 = toRadians(start.latitude);
	const lambda1 = toRadians(start.longitude);
	const phi2 = toRadians(end.latitude);
	const lambda2 = toRadians(end.longitude);
	const a2b2b2 = (WGS84_A * WGS84_A - WGS84_B * WGS84_B) / (WGS84_B * WGS84_B);
	const omega = lambda2 - lambda1;
	const u1 = Math.atan((1 - WGS84_F) * Math.tan(phi1));
	const u2 = Math.atan((1 - WGS84_F) * Math.tan(phi2));
	const sinU1 = Math.sin(u1);
	const cosU1 = Math.cos(u1);
	const sinU2 = Math.sin(u2);
	const cosU2 = Math.cos(u2);
	const sinU1sinU2 = sinU1 * sinU2;
	const cosU1sinU2 = cosU1 * sinU2;
	const sinU1cosU2 = sinU1 * cosU2;
	const cosU1cosU2 = cosU1 * cosU2;
	let lambda = omega;
	let coefficientA = 0;
	let coefficientB = 0;
	let sigma = 0;
	let deltaSigma = 0;
	let converged = false;
	for (let iteration = 0; iteration < 20; iteration += 1) {
		const previousLambda = lambda;
		const sinLambda = Math.sin(lambda);
		const cosLambda = Math.cos(lambda);
		const sin2Sigma =
			(cosU2 * sinLambda) ** 2 + (cosU1sinU2 - sinU1cosU2 * cosLambda) ** 2;
		const sinSigma = Math.sqrt(sin2Sigma);
		const cosSigma = sinU1sinU2 + cosU1cosU2 * cosLambda;
		sigma = Math.atan2(sinSigma, cosSigma);
		const sinAlpha = sin2Sigma === 0 ? 0 : (cosU1cosU2 * sinLambda) / sinSigma;
		const cos2Alpha = Math.cos(Math.asin(sinAlpha)) ** 2;
		const cos2SigmaM =
			cos2Alpha === 0 ? 0 : cosSigma - (2 * sinU1sinU2) / cos2Alpha;
		const uSquared = cos2Alpha * a2b2b2;
		coefficientA =
			1 +
			(uSquared / 16384) *
				(4096 + uSquared * (-768 + uSquared * (320 - 175 * uSquared)));
		coefficientB =
			(uSquared / 1024) *
			(256 + uSquared * (-128 + uSquared * (74 - 47 * uSquared)));
		deltaSigma =
			coefficientB *
			sinSigma *
			(cos2SigmaM +
				(coefficientB / 4) *
					(cosSigma * (-1 + 2 * cos2SigmaM ** 2) -
						(coefficientB / 6) *
							cos2SigmaM *
							(-3 + 4 * sin2Sigma) *
							(-3 + 4 * cos2SigmaM ** 2)));
		const coefficientC =
			(WGS84_F / 16) * cos2Alpha * (4 + WGS84_F * (4 - 3 * cos2Alpha));
		lambda =
			omega +
			(1 - coefficientC) *
				WGS84_F *
				sinAlpha *
				(sigma +
					coefficientC *
						sinSigma *
						(cos2SigmaM +
							coefficientC * cosSigma * (-1 + 2 * cos2SigmaM ** 2)));
		const change = Math.abs((lambda - previousLambda) / lambda);
		if (iteration > 1 && change < 1e-13) {
			converged = true;
			break;
		}
	}
	const distance = WGS84_B * coefficientA * (sigma - deltaSigma);
	let azimuth: number;
	if (!converged) {
		azimuth = phi1 > phi2 ? 180 : phi1 < phi2 ? 0 : Number.NaN;
	} else {
		let radians = Math.atan2(
			cosU2 * Math.sin(lambda),
			cosU1sinU2 - sinU1cosU2 * Math.cos(lambda),
		);
		if (radians < 0) radians += 2 * Math.PI;
		azimuth = toDegrees(radians);
	}
	if (azimuth >= 360) azimuth -= 360;
	return { distance, azimuth };
}

/** Vincenty's direct formula, ported from geodesy 1.1.3. */
function vincentyDirect(
	start: Point,
	bearing: number,
	distance: number,
): Point {
	const phi1 = toRadians(start.latitude);
	const alpha1 = toRadians(bearing);
	const cosAlpha1 = Math.cos(alpha1);
	const sinAlpha1 = Math.sin(alpha1);
	const tanU1 = (1 - WGS84_F) * Math.tan(phi1);
	const cosU1 = 1 / Math.sqrt(1 + tanU1 * tanU1);
	const sinU1 = tanU1 * cosU1;
	const sigma1 = Math.atan2(tanU1, cosAlpha1);
	const sinAlpha = cosU1 * sinAlpha1;
	const sin2Alpha = sinAlpha * sinAlpha;
	const cos2Alpha = 1 - sin2Alpha;
	const uSquared =
		(cos2Alpha * (WGS84_A * WGS84_A - WGS84_B * WGS84_B)) / (WGS84_B * WGS84_B);
	const coefficientA =
		1 +
		(uSquared / 16384) *
			(4096 + uSquared * (-768 + uSquared * (320 - 175 * uSquared)));
	const coefficientB =
		(uSquared / 1024) *
		(256 + uSquared * (-128 + uSquared * (74 - 47 * uSquared)));
	const sigmaBase = distance / (WGS84_B * coefficientA);
	let sigma = sigmaBase;
	let previousSigma = sigmaBase;
	while (!Number.isNaN(previousSigma)) {
		const sigmaM2 = 2 * sigma1 + sigma;
		const cosSigmaM2 = Math.cos(sigmaM2);
		const sinSigma = Math.sin(sigma);
		const cosSigma = Math.cos(sigma);
		const deltaSigma =
			coefficientB *
			sinSigma *
			(cosSigmaM2 +
				(coefficientB / 4) *
					(cosSigma * (-1 + 2 * cosSigmaM2 ** 2) -
						(coefficientB / 6) *
							cosSigmaM2 *
							(-3 + 4 * sinSigma ** 2) *
							(-3 + 4 * cosSigmaM2 ** 2)));
		sigma = sigmaBase + deltaSigma;
		if (Math.abs(sigma - previousSigma) < 1e-13) break;
		previousSigma = sigma;
	}
	const sigmaM2 = 2 * sigma1 + sigma;
	const cosSigmaM2 = Math.cos(sigmaM2);
	const cosSigma = Math.cos(sigma);
	const sinSigma = Math.sin(sigma);
	const phi2 = Math.atan2(
		sinU1 * cosSigma + cosU1 * sinSigma * cosAlpha1,
		(1 - WGS84_F) *
			Math.sqrt(
				sin2Alpha + (sinU1 * sinSigma - cosU1 * cosSigma * cosAlpha1) ** 2,
			),
	);
	const lambda = Math.atan2(
		sinSigma * sinAlpha1,
		cosU1 * cosSigma - sinU1 * sinSigma * cosAlpha1,
	);
	const coefficientC =
		(WGS84_F / 16) * cos2Alpha * (4 + WGS84_F * (4 - 3 * cos2Alpha));
	const longitudeDelta =
		lambda -
		(1 - coefficientC) *
			WGS84_F *
			sinAlpha *
			(sigma +
				coefficientC *
					sinSigma *
					(cosSigmaM2 + coefficientC * cosSigma * (-1 + 2 * cosSigmaM2 ** 2)));
	return canonicalize({
		latitude: toDegrees(phi2),
		longitude: start.longitude + toDegrees(longitudeDelta),
	});
}

function toRadians(degrees: number): number {
	return (degrees * Math.PI) / 180;
}

function toDegrees(radians: number): number {
	return (radians * 180) / Math.PI;
}
