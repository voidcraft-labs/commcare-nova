import { describe, expect, it } from "vitest";
import { parser } from "../xpath-parser";

/** Returns true if the parse tree contains no error nodes (⚠). */
function parsesClean(expr: string): boolean {
	const tree = parser.parse(expr);
	let hasError = false;
	tree.iterate({
		enter(node) {
			if (node.name === "⚠") hasError = true;
		},
	});
	return !hasError;
}

/** Returns all node names found anywhere in the parse tree. */
function allNodes(expr: string): string[] {
	const tree = parser.parse(expr);
	const names: string[] = [];
	tree.iterate({
		enter(node) {
			names.push(node.name);
		},
	});
	return names;
}

describe("CommCare XPath Parser", () => {
	// --------------- Numbers ---------------
	describe("numbers", () => {
		const cases = [
			"10",
			"123.",
			"734.04",
			"0.12345",
			".666",
			"00000333.3330000",
			"1230000000000000000000",
			"0",
			"0.",
			".0",
			"0.0",
		];
		it.each(cases)("parses %s", (expr) => {
			expect(parsesClean(expr)).toBe(true);
			expect(allNodes(expr)).toContain("NumberLiteral");
		});
	});

	// --------------- Strings ---------------
	describe("strings", () => {
		const cases = [
			'""',
			'"   "',
			"''",
			"'\"'",
			'"\'"',
			"'mary had a little lamb'",
		];
		it.each(cases)("parses %s", (expr) => {
			expect(parsesClean(expr)).toBe(true);
			expect(allNodes(expr)).toContain("StringLiteral");
		});
	});

	// --------------- Variables ---------------
	describe("variables", () => {
		it.each(["$var", "$qualified:name"])("parses %s", (expr) => {
			expect(parsesClean(expr)).toBe(true);
			expect(allNodes(expr)).toContain("VariableReference");
		});
	});

	// --------------- Parentheses ---------------
	describe("parentheses", () => {
		it.each(["(5)", "(( (( (5 )) )))  "])("parses %s", (expr) => {
			expect(parsesClean(expr)).toBe(true);
		});
	});

	// --------------- Arithmetic & comparison operators ---------------
	describe("operators", () => {
		const valid = [
			"5 + 5",
			"-5",
			"- 5",
			"----5",
			"6 * - 7",
			"0--0",
			"5 * 5",
			"5 div 5",
			"5 mod 5",
			"3mod 7",
			"5 = 5",
			"5 != 5",
			"5 < 5",
			"5 <= 5",
			"5 > 5",
			"5 >= 5",
			"5 and 5",
			"5 or 5",
			"5 | 5",
		];
		it.each(valid)("parses %s", (expr) => {
			expect(parsesClean(expr)).toBe(true);
		});
	});

	// --------------- Context-sensitive edge cases ---------------
	// These require a stateful lexer (like Jison's 3-state VAL/OP context)
	// to distinguish keyword from identifier when no whitespace is present.
	// Not supported — CommCare expressions always use spaces around operators.
	describe("context-sensitive (unsupported)", () => {
		it.each([
			"3mod4",
			"3 mod6",
			"4andfunc()",
		])("does not cleanly parse %s", (expr) => {
			expect(parsesClean(expr)).toBe(false);
		});
	});

	// --------------- Operator associativity ---------------
	describe("associativity", () => {
		const cases = [
			"1 or 2 or 3",
			"1 and 2 and 3",
			"1 = 2 != 3 != 4 = 5",
			"1 < 2 >= 3 <= 4 > 5",
			"1 + 2 - 3 - 4 + 5",
			"1 mod 2 div 3 div 4 * 5",
			"1|2|3",
		];
		it.each(cases)("parses %s", (expr) => {
			expect(parsesClean(expr)).toBe(true);
		});
	});

	// --------------- Operator precedence ---------------
	describe("precedence", () => {
		const cases = [
			"1 < 2 = 3 > 4 and 5 <= 6 != 7 >= 8 or 9 and 10",
			"1 * 2 + 3 div 4 < 5 mod 6 | 7 - 8",
			"- 4 * 6",
			"6 * (3 + 4) and (5 or 2)",
			"(1 - 2) - 3",
			"1 - (2 - 3)",
		];
		it.each(cases)("parses %s", (expr) => {
			expect(parsesClean(expr)).toBe(true);
		});
	});

	// --------------- Function calls ---------------
	describe("functions", () => {
		const valid = [
			"function()",
			"func:tion()",
			"function(   )",
			"function (5)",
			"function   ( 5, 'arg', 4 * 12)",
		];
		it.each(valid)("parses %s", (expr) => {
			expect(parsesClean(expr)).toBe(true);
		});
	});

	// --------------- Node tests ---------------
	describe("node tests", () => {
		const valid = ["node()", "text()", "comment()", "processing-instruction()"];
		it.each(valid)("parses %s", (expr) => {
			expect(parsesClean(expr)).toBe(true);
		});
	});

	// --------------- Filter expressions ---------------
	describe("filters", () => {
		const cases = [
			"bunch-o-nodes()[3]",
			"bunch-o-nodes()[3]['predicates'!='galore']",
			"(bunch-o-nodes)[3]",
			"bunch-o-nodes[3]",
		];
		it.each(cases)("parses %s", (expr) => {
			expect(parsesClean(expr)).toBe(true);
		});
	});

	// --------------- Path steps ---------------
	describe("steps", () => {
		it.each([".", "..", "..[4]"])("parses %s", (expr) => {
			expect(parsesClean(expr)).toBe(true);
		});
	});

	// --------------- Name tests ---------------
	describe("name tests", () => {
		const valid = ["name", "qual:name", "_rea--ll:y", "*", "*****"];
		it.each(valid)("parses %s", (expr) => {
			expect(parsesClean(expr)).toBe(true);
		});
	});

	// --------------- Axes ---------------
	describe("axes", () => {
		const axes = [
			"child::*",
			"parent::*",
			"descendant::*",
			"ancestor::*",
			"following-sibling::*",
			"preceding-sibling::*",
			"following::*",
			"preceding::*",
			"attribute::*",
			"namespace::*",
			"self::*",
			"descendant-or-self::*",
			"ancestor-or-self::*",
			"@attr",
			"@*",
			"@ns:*",
		];
		it.each(axes)("parses %s", (expr) => {
			expect(parsesClean(expr)).toBe(true);
		});
	});

	// --------------- Predicates ---------------
	describe("predicates", () => {
		it("parses descendant::node()[@attr='blah'][4]", () => {
			expect(parsesClean("descendant::node()[@attr='blah'][4]")).toBe(true);
		});
	});

	// --------------- Paths ---------------
	describe("paths", () => {
		const cases = [
			"rel/ative/path",
			"/abs/olute/path['etc']",
			"filter()/expr/path",
			"fil()['ter']/expr/path",
			"(another-filter)/expr/path",
			"/",
			"//all",
			"a/.//../z",
		];
		it.each(cases)("parses %s", (expr) => {
			expect(parsesClean(expr)).toBe(true);
		});
	});

	// --------------- Real world examples ---------------
	describe("real world", () => {
		const cases = [
			"/foo/bar = 2.0",
			"/patient/sex = 'male' and /patient/age > 15",
			'../jr:hist-data/labs[@type="cd4"]',
			"function_call(26*(7+3), //*, /im/child::an/ancestor::x[3][true()]/path)",
		];
		it.each(cases)("parses %s", (expr) => {
			expect(parsesClean(expr)).toBe(true);
		});
	});

	// --------------- CommCare hashtag references ---------------
	describe("hashtags", () => {
		const cases = [
			"#form/field",
			"#form/group/field",
			"#case/type/prop",
			"#form/field = #case/property",
			"#form/field     =    #case/property",
			"/data/filtered[@id = #form/field]",
			"-some-function(#form/field)",
		];
		it.each(cases)("parses %s", (expr) => {
			expect(parsesClean(expr)).toBe(true);
		});

		it("identifies HashtagRef nodes", () => {
			expect(allNodes("#form/field")).toContain("HashtagRef");
		});
	});

	// --------------- Combined CommCare expressions ---------------
	describe("commcare combined", () => {
		const cases = [
			"#case/age > 18 and #form/gender = 'male'",
			"count(instance('casedb')/casedb/case)",
			". = 'yes' or . = 'no'",
			"if(#case/status = 'active', 'Open', 'Closed')",
			"/data/registration/name",
			"today() - date(#case/dob)",
			"$var + 1",
			"concat(#case/first_name, ' ', #case/last_name)",
			"selected(#form/symptoms, 'fever')",
			'#case/dob != ""',
		];
		it.each(cases)("parses %s", (expr) => {
			expect(parsesClean(expr)).toBe(true);
		});
	});
});
