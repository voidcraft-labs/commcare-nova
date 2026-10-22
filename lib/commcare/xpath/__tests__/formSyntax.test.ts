import { describe, expect, it } from "vitest";
import {
	type FormSyntax,
	formSyntaxKey,
	matchFormSyntax,
	readFormSyntax,
} from "../formSyntax";

function syntax(source: string): FormSyntax {
	const result = readFormSyntax(source);
	if (!result.ok || result.node === undefined)
		throw new Error(`Source refused: ${source}`);
	return result.node;
}
function matchingNames(before: string, after: string): number {
	let count = 0;
	matchFormSyntax(syntax(before), syntax(after), (left, right) => {
		if (
			left.kind === "name" &&
			right.kind === "name" &&
			formSyntaxKey(left) === formSyntaxKey(right)
		)
			count++;
	});
	return count;
}

describe("production XPath structural reading", () => {
	it("retains grouping inside binary operands and function arguments", () => {
		expect(syntax("(1 + 2) * 3")).toMatchObject({
			kind: "binary",
			op: "*",
			left: { kind: "group", value: { kind: "binary", op: "+" } },
			right: { kind: "number", value: 3 },
		});
		expect(syntax("if((1 = 2), concat('a', 'b'), 4)")).toMatchObject({
			kind: "call",
			name: "if",
			args: [
				{ kind: "group", value: { kind: "binary", op: "=" } },
				{
					kind: "call",
					name: "concat",
					args: [
						{ kind: "string", value: "a" },
						{ kind: "string", value: "b" },
					],
				},
				{ kind: "number", value: 4 },
			],
		});
	});
	it("retains named attribute filters, current roots and multiple row predicates", () => {
		expect(syntax("current()/../@id[. = 'a']")).toMatchObject({
			kind: "filter",
			base: {
				kind: "child",
				left: {
					kind: "child",
					left: { kind: "call", name: "current" },
					step: { kind: "parent" },
				},
				step: {
					kind: "axis",
					axis: "attribute",
					value: { kind: "name", name: "id" },
				},
			},
		});
		expect(
			syntax(
				"instance('casedb')/casedb/case[@case_type = 'visit'][age > 5]/name",
			),
		).toMatchObject({
			kind: "child",
			left: { kind: "filter", base: { kind: "filter" } },
			step: { kind: "name", name: "name" },
		});
	});
	it("reports syntax failures and treats whitespace as an absent expression", () => {
		expect(readFormSyntax("if(1, ")).toMatchObject({
			ok: false,
			issues: [{ from: expect.any(Number), to: expect.any(Number) }],
		});
		expect(readFormSyntax(" \n\t")).toEqual({ ok: true, node: undefined });
	});
	it("pairs unchanged repeated occurrences and withholds repeated hints after an array edit", () => {
		expect(matchingNames("concat(age, age)", "concat(age, age)")).toBe(2);
		expect(matchingNames("concat(age, age)", "concat(age, age, name)")).toBe(0);
		expect(matchingNames("concat(age, age, name)", "concat(age, name)")).toBe(
			1,
		);
		expect(matchingNames("concat(age, name)", "concat(name, age)")).toBe(1);
	});
});
