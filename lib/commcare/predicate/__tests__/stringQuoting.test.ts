import fc from "fast-check";
import { expect, it } from "vitest";
import {
	formatNumeric,
	isCsqlStringLiteralRepresentable,
	quoteLiteral,
} from "../stringQuoting";

// Private lexical output, not consumer acceptance. Native query proofs consume
// emitted artifacts and evaluate runtime answers without substituting XPath.
it.each([
	["", "''", "''"],
	["Alice", "'Alice'", "'Alice'"],
	['say "hello"', `'say "hello"'`, `'say "hello"'`],
	["a b\tc\nd 日本", "'a b\tc\nd 日本'", "'a b\tc\nd 日本'"],
	["O'Brien", `concat('O', "'", 'Brien')`, `"O'Brien"`],
	["'", `concat('', "'", '')`, `"'"`],
	["a''b", `concat('a', "'", '', "'", 'b')`, `"a''b"`],
	["a'b'c'd", `concat('a', "'", 'b', "'", 'c', "'", 'd')`, `"a'b'c'd"`],
	["naïve\nO'Brien", `concat('naïve\nO', "'", 'Brien')`, `"naïve\nO'Brien"`],
	[`it's "quoted"`, `concat('it', "'", 's "quoted"')`, null],
] as const)("quotes %j in each dialect", (value, device, csql) => {
	for (const dialect of ["case-list-filter", "search-filter"] as const)
		expect(quoteLiteral(value, dialect)).toBe(device);
	expect(isCsqlStringLiteralRepresentable(value)).toBe(csql !== null);
	if (csql === null)
		expect(() => quoteLiteral(value, "csql")).toThrow(/no portable escape/);
	else expect(quoteLiteral(value, "csql")).toBe(csql);
});

it("retains compact ordinary decimals and expands exponent notation without rounding", () => {
	for (const [value, expected] of [
		[0, "0"],
		[-0, "0"],
		[42, "42"],
		[-3.14, "-3.14"],
		[1e-6, "0.000001"],
		[1.234e-7, "0.0000001234"],
		[-1.5e-7, "-0.00000015"],
		[1e20, "100000000000000000000"],
		[1.5e21, "1500000000000000000000"],
		[-2.5e25, "-25000000000000000000000000"],
	] as const)
		expect(formatNumeric(value)).toBe(expected);
});

it("round-trips finite IEEE values through decimal-only text, including extreme magnitudes", () => {
	const assertDecimal = (value: number) => {
		const text = formatNumeric(value);
		expect(text).toMatch(/^-?\d+(?:\.\d+)?$/);
		expect(Number(text)).toBe(value === 0 ? 0 : value);
	};
	for (const value of [
		Number.MIN_VALUE,
		-Number.MIN_VALUE,
		Number.MAX_VALUE,
		-Number.MAX_VALUE,
		Number.MIN_SAFE_INTEGER,
		Number.MAX_SAFE_INTEGER,
	])
		assertDecimal(value);
	fc.assert(
		fc.property(
			fc.double({ noNaN: true, noDefaultInfinity: true }),
			assertDecimal,
		),
		{ seed: 260906, numRuns: 2000 },
	);
});
