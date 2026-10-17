import type { SyntaxNode } from "@lezer/common";
import { describe, expect, it } from "vitest";
import { datetimeCaseValueExpression } from "@/lib/commcare/xform/datetimeCaseValue";
import { parser } from "@/lib/commcare/xpath/parser";

/** The blank test: the outermost `=` the calculate holds, as written. */
function blankTest(calculate: string): string {
	let found: SyntaxNode | undefined;
	parser.parse(calculate).iterate({
		enter(cursor) {
			if (found !== undefined) return false;
			if (cursor.name === "EqualsExpr") found = cursor.node;
		},
	});
	if (found === undefined) throw new Error(`No comparison in ${calculate}`);
	return calculate.slice(found.from, found.to);
}

describe("datetimeCaseValueExpression", () => {
	it("writes a path in the one spelling the datetime leaf takes", () => {
		expect(datetimeCaseValueExpression("/data/visit_time")).toBe(
			"if(/data/visit_time = '', '', format-date(coalesce(/data/visit_time, ''), '%Y-%m-%dT%H:%M:%S.%3%Z'))",
		);
	});

	it("compares the whole value with blank when its outermost operator binds more loosely than =", () => {
		for (const value of [
			"/data/a or /data/b",
			"/data/a and /data/b",
			"if(/data/c, /data/a, /data/b) or now()",
		]) {
			expect(blankTest(datetimeCaseValueExpression(value))).toBe(
				`(${value}) = ''`,
			);
		}
	});

	it("leaves a value that binds at least as tightly as = bare", () => {
		for (const value of [
			"now()",
			"/data/a + 1",
			"/data/a < /data/b",
			"/data/a = /data/b",
		]) {
			expect(blankTest(datetimeCaseValueExpression(value))).toBe(
				`${value} = ''`,
			);
		}
	});
});
