import { describe, expect, it } from "vitest";
import { type FormSyntax, readFormSyntax } from "../../xpath/formSyntax";
import {
	type CompareOptions,
	firstDifference,
	sameSyntax,
	sameXPathText,
} from "../syntaxCompare";

const FORM: CompareOptions = { ruleSet: "form" };
const RECORD: CompareOptions = { ruleSet: "record" };

function tree(text: string): FormSyntax {
	const read = readFormSyntax(text);
	if (!read.ok || read.node === undefined)
		throw new Error(`The test text ${text} does not parse.`);
	return read.node;
}

describe("the closed table of spellings Core reads alike", () => {
	it.each([
		["whitespace", "1+1", "1 + 1"],
		["whitespace", "a  =\n'x'", "a = 'x'"],
		["whitespace", "a\t=\f'x'", "a = 'x'"],
		["whitespace", "selected( a ,'x' )", "selected(a, 'x')"],
		["grouping", "(1 + 2) * 3", "(1 + 2) * 3"],
		["grouping", "((a))", "a"],
		["grouping", "(a = b)", "a = b"],
		["quotes", `"a"`, "'a'"],
		["quotes", `"it's"`, `"it's"`],
		["numbers", "1", "1.0"],
		["numbers", "01", "1"],
		["numbers", ".5", "0.5"],
		["numbers", "1.", "1"],
		["axes", "child::a", "a"],
		["axes", "x/self::node()", "x/."],
		["axes", "x/parent::node()", "x/.."],
		["axes", "attribute::a", "@a"],
		["predicate-node", "x[./. = 'a']", "x[. = 'a']"],
	])("%s holds %s as %s", (_row, source, print) => {
		expect(sameXPathText(source, print, FORM)).toBe(true);
		expect(sameXPathText(source, print, RECORD)).toBe(true);
	});

	it.each([
		["a and (b and c)", "a and b and c"],
		["a != b", "not(a = b)"],
		["1", "'1'"],
		["child::*", "a"],
		["self::a", "."],
		["a", "b"],
		["count(a)", "count(a, b)"],
		["a/b", "a//b"],
		["@a", "a"],
	])("keeps %s apart from %s", (source, print) => {
		expect(sameXPathText(source, print, FORM)).toBe(false);
		expect(sameXPathText(source, print, RECORD)).toBe(false);
	});

	it("reads a step named like the operator beside it as a step", () => {
		// Core's Lexer reads the first `mod` as a name and the second as the
		// operator, so a property named `mod` is an operand, never a separator.
		expect(sameXPathText("mod mod 2", "mod mod 2")).toBe(true);
		expect(sameXPathText("mod mod 2 = 0", "mod mod 2 = 0", RECORD)).toBe(true);
		expect(sameXPathText("div div div", "div div div", FORM)).toBe(true);
		expect(sameXPathText("and and b", "and and b")).toBe(true);
		expect(sameXPathText("or or or", "or or or")).toBe(true);
		expect(sameXPathText("mod mod 2", "mod mod 3")).toBe(false);
		const read = readFormSyntax("mod mod 2");
		expect(read.ok && read.node).toMatchObject({
			kind: "binary",
			op: "mod",
			left: { kind: "name", name: "mod" },
			right: { kind: "number", value: 2 },
		});
	});

	it("reads ./. as . inside a predicate only", () => {
		expect(sameXPathText("./.", ".", FORM)).toBe(false);
		expect(sameXPathText("x[./. = 'a']", "x[. = 'a']", FORM)).toBe(true);
	});

	it("reads cond as nested if in a record slot and nowhere else", () => {
		const cond = "cond(a = 1, 'x', b = 2, 'y', 'z')";
		const nested = "if(a = 1, 'x', if(b = 2, 'y', 'z'))";
		expect(sameXPathText(cond, nested, RECORD)).toBe(true);
		expect(sameXPathText("cond(a, 'x', 'z')", "if(a, 'x', 'z')", RECORD)).toBe(
			true,
		);
		expect(sameXPathText(cond, nested, FORM)).toBe(false);
		// An even count of arguments is no `cond` Core runs as a chain.
		expect(sameXPathText("cond(a, 'x')", "if(a, 'x')", RECORD)).toBe(false);
		// The print side never holds `cond`, so it is compared as written.
		expect(sameXPathText(nested, cond, RECORD)).toBe(false);
	});

	it("reads is-selected as selected in every slot, on the source side alone", () => {
		// Core builds one function for either name
		// (`ASTNodeFunctionCall.java`, `XPathSelectedFunc`).
		for (const options of [FORM, RECORD])
			expect(
				sameXPathText(
					"is-selected(/data/code, 'a')",
					"selected(/data/code, 'a')",
					options,
				),
			).toBe(true);
		// Nova's print never holds `is-selected`, so it is compared as written.
		expect(
			sameXPathText("selected(a, 'x')", "is-selected(a, 'x')", RECORD),
		).toBe(false);
	});

	it("holds a case row's name step apart from case_name", () => {
		// Core's casedb answers a `name` step with a blank node
		// (`CaseChildElement.getChildrenWithName`), so it is another read.
		for (const options of [FORM, RECORD]) {
			expect(
				sameXPathText("name = 'Asha'", "case_name = 'Asha'", options),
			).toBe(false);
			expect(
				sameXPathText(
					"count(instance('casedb')/casedb/case[name = 'Asha'])",
					"count(instance('casedb')/casedb/case[case_name = 'Asha'])",
					options,
				),
			).toBe(false);
			expect(
				sameXPathText(
					"instance('casedb')/casedb/case[@case_id = '1']/case_name",
					"instance('casedb')/casedb/case[@case_id = '1']/case_name",
					options,
				),
			).toBe(true);
		}
	});

	it("maps a source's local instance and itext ids before comparing", () => {
		const options: CompareOptions = {
			ruleSet: "form",
			instanceId: (id) => (id === "cases" ? "casedb" : id),
			itextId: (id) => (id === "q1-label" ? "q1-label-nova" : id),
		};
		expect(
			sameXPathText(
				"count(instance('cases')/casedb/case)",
				"count(instance('casedb')/casedb/case)",
				options,
			),
		).toBe(true);
		expect(
			sameXPathText(
				"jr:itext('q1-label')",
				"jr:itext('q1-label-nova')",
				options,
			),
		).toBe(true);
		// Nova's own print spells its own ids, so the map never reaches it.
		expect(
			sameXPathText(
				"count(instance('casedb')/casedb/case)",
				"count(instance('cases')/casedb/case)",
				options,
			),
		).toBe(false);
	});

	it("names the first differing source node in document order", () => {
		const source = tree("a = 1 and b = 2 and c = 3");
		const print = tree("a = 1 and b = 5 and c = 4");
		const found = firstDifference(source, print, FORM);
		expect(found?.kind).toBe("number");
		expect(found?.from).toBe(14);
		expect(firstDifference(source, source, FORM)).toBeUndefined();
		// A group is its value, and the node named carries the source's span.
		const grouped = firstDifference(tree("(x) + 1"), tree("y + 1"), FORM);
		expect(grouped).toMatchObject({ kind: "name", name: "x", from: 1, to: 2 });
		// A call with another number of arguments differs at the call.
		expect(
			firstDifference(tree("concat(a, b)"), tree("concat(a)"), FORM),
		).toMatchObject({ kind: "call", from: 0 });
	});

	it("defaults to the record rule set", () => {
		const cond = "cond(a, 'x', 'y')";
		const nested = "if(a, 'x', 'y')";
		expect(sameSyntax(tree(cond), tree(nested))).toBe(true);
		expect(sameXPathText(cond, nested)).toBe(true);
	});

	it("holds two blank texts alike and an unreadable text unlike anything", () => {
		expect(sameXPathText("", "  ", FORM)).toBe(true);
		expect(sameXPathText("", "a", FORM)).toBe(false);
		expect(sameXPathText("a = ", "a = ", FORM)).toBe(false);
	});
});
