import { describe, expect, it } from "vitest";
import { openJdk17DoubleToString } from "../openJdk17DoubleString";
import corpus from "./fixtures/double-text-openjdk17.json";

describe("OpenJDK 17 double text", () => {
	it("matches native OpenJDK 17 over exact IEEE-754 boundary and seeded bit patterns", () => {
		const storage = new DataView(new ArrayBuffer(8));
		for (const [bits, expected] of corpus) {
			if (bits === undefined || expected === undefined)
				throw new Error("Invalid oracle vector");
			storage.setBigUint64(0, BigInt(`0x${bits}`));
			expect(openJdk17DoubleToString(storage.getFloat64(0)), bits).toBe(
				expected,
			);
		}
	});

	it("retains FloatingDecimal spellings across ordinary and boundary values", () => {
		const vectors: readonly [number, string][] = [
			[0, "0.0"],
			[-0, "-0.0"],
			[1e7, "1.0E7"],
			[1e-4, "1.0E-4"],
			[1e23, "9.999999999999999E22"],
			[0.8455124082255701, "0.8455124082255701"],
			[Number.MIN_VALUE, "4.9E-324"],
			[2.2250738585072014e-308, "2.2250738585072014E-308"],
			[Number.MAX_VALUE, "1.7976931348623157E308"],
			[Number.POSITIVE_INFINITY, "Infinity"],
			[Number.NEGATIVE_INFINITY, "-Infinity"],
		];
		for (const [value, expected] of vectors) {
			expect(openJdk17DoubleToString(value)).toBe(expected);
		}
		expect(openJdk17DoubleToString(Number.NaN)).toBe("NaN");
	});
});
