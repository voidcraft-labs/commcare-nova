import { describe, expect, it } from "vitest";
import {
	javaRosaClosestPointOnPolygon,
	javaRosaDistance,
	javaRosaIsPointInsidePolygon,
	parseJavaDouble,
} from "../javaRosaGeo";

describe("JavaRosa geographic functions", () => {
	it("matches Core's distance contract", () => {
		expect(javaRosaDistance("", "40 -74")).toBe(-1);
		expect(javaRosaDistance("40 -74 10 2", "40 -74 0 1")).toBe(0);
		expect(javaRosaDistance("40.7 -74.0 95 0", "37.8 -122.4 16 0")).toBeCloseTo(
			4_127_316,
			-2,
		);
	});

	it("matches Core's point-in-polygon fixtures including a vertex", () => {
		const polygon =
			"27.2043773 78.0186987 27.203509 78.0187201 27.2035281 78.0202758 27.2044155 78.0203027";
		expect(javaRosaIsPointInsidePolygon("27.204 78.0195", polygon)).toBe(true);
		expect(javaRosaIsPointInsidePolygon("27.2035 78.0205", polygon)).toBe(
			false,
		);
		expect(javaRosaIsPointInsidePolygon("27.203509 78.0187201", polygon)).toBe(
			true,
		);
		expect(javaRosaIsPointInsidePolygon("5 6", "0 0 0 10 10 0 0 0")).toBe(
			false,
		);
	});

	it("matches Core's Vincenty closest-point fixtures", () => {
		const polygon =
			"27.174957 78.041309 27.174884 78.042574 27.175493 78.042661 27.175569 78.041383";
		expect(javaRosaClosestPointOnPolygon("27.176 78.041", polygon)).toBe(
			"27.175568999999996 78.041383",
		);
		expect(javaRosaClosestPointOnPolygon("27.175 78.043", polygon)).toBe(
			"27.175046033871524 78.04259714760224",
		);
		expect(javaRosaClosestPointOnPolygon("0 0", "0 0 0 1 1 1 1 0")).toBe(
			"0.0 0.0",
		);
	});

	it("rejects malformed polygon coordinates", () => {
		expect(() => javaRosaClosestPointOnPolygon("27 78", "27 78 28 79")).toThrow(
			"three distinct vertices",
		);
		expect(() =>
			javaRosaIsPointInsidePolygon("91 78", "27 78 28 79 29 80"),
		).toThrow("Invalid coordinates");
		expect(() => javaRosaDistance("27 78 1 2 3", "28 79")).toThrow(
			"four coordinates",
		);
		expect(() => javaRosaDistance("27 78 invalid", "28 79")).toThrow("numeric");
		expect(() =>
			javaRosaIsPointInsidePolygon("27 78", "27 78  28 79 29 80"),
		).toThrow();
	});

	it("uses Java Double.parseDouble's coordinate grammar and rounding", () => {
		expect(parseJavaDouble("1f")).toBe(1);
		expect(parseJavaDouble("+Infinity")).toBe(Number.POSITIVE_INFINITY);
		expect(parseJavaDouble("-NaN")).toBeNaN();
		expect(parseJavaDouble("0x1.8p1")).toBe(3);
		expect(parseJavaDouble("0x1.00000000000008p0")).toBe(1);
		expect(parseJavaDouble("0x1.00000000000018p0")).toBe(1.0000000000000004);
		expect(parseJavaDouble("0x1.fffffffffffffp1023")).toBe(Number.MAX_VALUE);
		expect(parseJavaDouble("0x1.fffffffffffff8p1023")).toBe(
			Number.POSITIVE_INFINITY,
		);
		expect(parseJavaDouble("0x1p-1075")).toBe(0);
		expect(parseJavaDouble("0x0.0000000000000cp-1022")).toBe(Number.MIN_VALUE);
		expect(Object.is(parseJavaDouble("-0x1p-1075"), -0)).toBe(true);
		expect(() => parseJavaDouble("0x10")).toThrow("numeric");
		expect(() => parseJavaDouble("infinity")).toThrow("numeric");
		expect(javaRosaDistance("0x1p4 0", "16 0")).toBe(0);
		expect(javaRosaDistance("NaN 0", "0 0")).toBeNaN();
	});
});
