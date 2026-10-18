import { expect, it } from "vitest";
import {
	isCsqlStringLiteralRepresentable,
	quoteLiteral,
} from "../stringQuoting";

it.each([
	["", "''"],
	["Alice", "'Alice'"],
	['say "hello"', `'say "hello"'`],
	["a b\tc\nd 日本", "'a b\tc\nd 日本'"],
	["O'Brien", `"O'Brien"`],
	["'", `"'"`],
	["a''b", `"a''b"`],
	["a'b'c'd", `"a'b'c'd"`],
	["naïve\nO'Brien", `"naïve\nO'Brien"`],
	[`it's "quoted"`, null],
] as const)("quotes %j in the server-side CSQL grammar", (value, expected) => {
	expect(isCsqlStringLiteralRepresentable(value)).toBe(expected !== null);
	if (expected === null)
		expect(() => quoteLiteral(value, "csql")).toThrow(/no portable escape/);
	else expect(quoteLiteral(value, "csql")).toBe(expected);
});
