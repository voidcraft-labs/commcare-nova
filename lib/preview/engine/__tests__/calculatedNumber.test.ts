import { describe, expect, it } from "vitest";
import { heldCalculatedNumber } from "../calculatedNumber";

/**
 * Each vector is what `Recalculate.wrapData` holds for the double and what
 * `XFormAnswerDataSerializer` writes for that holding: `IntegerData` and
 * `LongData` their digits, `DecimalData` OpenJDK 17's `Double.toString`.
 */
describe("a calculated number as a device holds it", () => {
	it.each([
		[7, "7", 7],
		[3e9, "3000000000", 3e9],
		[2.0000000001, "2", 2],
		[-0.0000000001, "0", 0],
		[1e-10, "0", 0],
		[2e-9, "2.0E-9", 2e-9],
		[2.5, "2.5", 2.5],
		[1 / 3, "0.3333333333333333", 1 / 3],
		[1e21, "1.0E21", 1e21],
		[Number.POSITIVE_INFINITY, "Infinity", Number.POSITIVE_INFINITY],
		[Number.NEGATIVE_INFINITY, "-Infinity", Number.NEGATIVE_INFINITY],
	])("holds %d under any other bind as %s", (value, text, held) => {
		expect(heldCalculatedNumber(value, false)).toEqual({ text, value: held });
	});

	it.each([
		[2.7, "2"],
		[-2.7, "-2"],
		[3e9, "2147483647"],
		[-3e9, "-2147483648"],
		[Number.POSITIVE_INFINITY, "2147483647"],
		[-0.4, "0"],
	])("holds %d under a whole-number bind as its (int), %s", (value, text) => {
		expect(heldCalculatedNumber(value, true)).toEqual({
			text,
			value: Number(text),
		});
	});
});
