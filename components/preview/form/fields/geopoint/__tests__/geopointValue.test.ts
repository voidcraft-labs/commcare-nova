import { describe, expect, it } from "vitest";
import {
	formatGeopoint,
	type GeoPoint,
	isValidLat,
	isValidLon,
	parseGeopoint,
} from "../geopointValue";

// Mirrors `GEOPOINT_PATTERN` in lib/domain/predicate/jsonSchema.ts — four
// space-separated decimals. Every `formatGeopoint` output must satisfy it,
// or the case-store write-side AJV validator would reject the submission.
const DECIMAL = String.raw`-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?`;
const WIRE_PATTERN = new RegExp(`^${DECIMAL}(?: ${DECIMAL}){3}$`);

describe("parseGeopoint", () => {
	it("decodes a full four-token wire value", () => {
		expect(parseGeopoint("12.34 56.78 100 5")).toEqual<GeoPoint>({
			lat: 12.34,
			lon: 56.78,
			alt: 100,
			accuracy: 5,
		});
	});

	it("defaults altitude/accuracy to 0 for a bare lat lon", () => {
		expect(parseGeopoint("40.7128 -74.006")).toEqual<GeoPoint>({
			lat: 40.7128,
			lon: -74.006,
			alt: 0,
			accuracy: 0,
		});
	});

	it("tolerates extra internal whitespace and scientific notation", () => {
		const point = parseGeopoint("-7.130   -41.563  7.53E-4 8");
		expect(point?.lat).toBeCloseTo(-7.13);
		expect(point?.lon).toBeCloseTo(-41.563);
		expect(point?.alt).toBeCloseTo(0.000753);
	});

	it("returns null for empty, blank, or nullish input", () => {
		expect(parseGeopoint("")).toBeNull();
		expect(parseGeopoint("   ")).toBeNull();
		expect(parseGeopoint(undefined)).toBeNull();
		expect(parseGeopoint(null)).toBeNull();
	});

	it("returns null when lat or lon is out of range or non-numeric", () => {
		expect(parseGeopoint("91 0 0 0")).toBeNull();
		expect(parseGeopoint("0 181 0 0")).toBeNull();
		expect(parseGeopoint("north east")).toBeNull();
		expect(parseGeopoint("48.85")).toBeNull(); // only one token
	});
});

describe("formatGeopoint", () => {
	it("always emits four tokens matching the wire pattern", () => {
		const out = formatGeopoint({ lat: 12.34, lon: 56.78, alt: 0, accuracy: 0 });
		expect(out).toBe("12.34 56.78 0 0");
		expect(out).toMatch(WIRE_PATTERN);
	});

	it("drops float noise and trailing zeros from lat/lon", () => {
		const out = formatGeopoint({
			lat: 12.340000000001,
			lon: -0.1278,
			alt: 0,
			accuracy: 0,
		});
		expect(out).toBe("12.34 -0.1278 0 0");
		expect(out).toMatch(WIRE_PATTERN);
	});

	it("round-trips through parse for a map-picked point", () => {
		const wire = formatGeopoint({
			lat: 51.5074,
			lon: -0.1278,
			alt: 0,
			accuracy: 0,
		});
		expect(parseGeopoint(wire)).toEqual<GeoPoint>({
			lat: 51.5074,
			lon: -0.1278,
			alt: 0,
			accuracy: 0,
		});
	});
});

describe("range guards", () => {
	it("validates latitude bounds", () => {
		expect(isValidLat(0)).toBe(true);
		expect(isValidLat(90)).toBe(true);
		expect(isValidLat(-90)).toBe(true);
		expect(isValidLat(90.0001)).toBe(false);
		expect(isValidLat(Number.NaN)).toBe(false);
	});

	it("validates longitude bounds", () => {
		expect(isValidLon(180)).toBe(true);
		expect(isValidLon(-180)).toBe(true);
		expect(isValidLon(180.0001)).toBe(false);
		expect(isValidLon(Number.POSITIVE_INFINITY)).toBe(false);
	});
});
