import { describe, expect, it } from "vitest";
import { parseJavaDouble } from "../javaDouble";

// Each row is what JDK 17's `Double.parseDouble` returns for the text
// (`jdk.internal.math.FloatingDecimal::readJavaFormatString`), `undefined`
// standing for its `NumberFormatException`.
const ROWS: readonly (readonly [string, number | undefined])[] = [
	["1f", 1],
	["1", 1],
	["-0", -0],
	["1.", 1],
	[".5", 0.5],
	["1e3", 1000],
	["1E-3", 0.001],
	["1e+3D", 1000],
	[" 1e3d\t", 1000],
	["\u00001.5 ", 1.5],
	["+Infinity", Number.POSITIVE_INFINITY],
	["-Infinity", Number.NEGATIVE_INFINITY],
	["-NaN", Number.NaN],
	["NaN", Number.NaN],
	["0x1.8p1", 3],
	["0x1p3", 8],
	["0X.8P1f", 1],
	["0x1.00000000000008p0", 1],
	["0x1.00000000000018p0", 1.0000000000000004],
	["0x1.fffffffffffffp1023", Number.MAX_VALUE],
	["0x1.fffffffffffff8p1023", Number.POSITIVE_INFINITY],
	["0x1p-1075", 0],
	["0x0.0000000000000cp-1022", Number.MIN_VALUE],
	["-0x1p-1075", -0],
	// Rejected spellings.
	["NaNf", undefined],
	["NaNd", undefined],
	["Infinityd", undefined],
	["InfinityF", undefined],
	["infinity", undefined],
	["nan", undefined],
	["0x10", undefined],
	["0x1.8", undefined],
	["", undefined],
	["   ", undefined],
	[".", undefined],
	["1e", undefined],
	["1e+", undefined],
	["1ff", undefined],
	["1_000", undefined],
	["1,5", undefined],
	[" 1", undefined],
	["١", undefined],
	["+", undefined],
	["--1", undefined],
];

describe("parseJavaDouble", () => {
	it.each(ROWS)("reads %j as Java does", (text, expected) => {
		const parsed = parseJavaDouble(text);
		if (expected === undefined) {
			expect(parsed).toBeUndefined();
		} else {
			expect(Object.is(parsed, expected)).toBe(true);
		}
	});
});
