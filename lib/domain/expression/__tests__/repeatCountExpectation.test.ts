// lib/domain/expression/__tests__/repeatCountExpectation.test.ts
//
// A repeat count is a whole number. CommCare reads it as
// `IntegerData().cast(count.uncast())` (`FormEntryModel.createModelForGroup`,
// `FormDef.canCreateRepeat`), which is `Integer.parseInt`, and stops the form
// on anything it cannot read. The checker is the semantic authority every
// surface gates through, so these cases parse authored text in the count slot
// of a built document and check it there. Plausible failure: a decimal or a
// text count admitted, or an integer select refused.

import { describe, expect, it } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import {
	buildDoc,
	caseListConfig,
	f,
	parseFixtureExpression,
} from "@/lib/__tests__/docHelpers";
import type { BlueprintDoc } from "@/lib/domain";
import { slotContext } from "../context";
import { checkExpression, typeOf } from "../typeChecker";
import type { Expression, ExpressionSlotRef } from "../types";

const ids = Object.fromEntries(
	["module", "form", "count", "reader", "other", "inner"].map((name) => [
		name,
		testUuid(`repeat-count-expectation-${name}`),
	]),
) as Record<
	"module" | "form" | "count" | "reader" | "other" | "inner",
	ReturnType<typeof testUuid>
>;

const inline = (field: string, values: readonly string[]) => ({
	kind: "inline",
	options: values.map((value, index) => ({
		uuid: testUuid(`repeat-count-choice-${field}-${index}`),
		value,
		label: `Choice ${index + 1}`,
	})),
});

/** A read of the count repeat's count, as a form stores it. */
const countRead: Expression = {
	kind: "term",
	term: {
		kind: "form-node",
		node: { kind: "repeat", repeat: ids.count, role: "count-result" },
		spelling: "relative",
	},
};

/** One registration form with a question of every kind a count might read,
 * a count repeat, and a second one whose calculate reads the first's count. */
function countDoc(
	integerChoices: readonly string[],
	count = "2",
): BlueprintDoc {
	return buildDoc({
		appName: "Counts",
		caseTypes: [
			{
				name: "household",
				properties: [{ name: "case_name", label: "Name" }],
			},
		],
		modules: [
			{
				uuid: ids.module,
				name: "Households",
				caseType: "household",
				caseListConfig: caseListConfig([
					{ field: "case_name", header: "Name" },
				]),
				forms: [
					{
						uuid: ids.form,
						name: "Register",
						type: "registration",
						fields: [
							f({
								id: "name",
								kind: "text",
								caseWrite: { caseType: "household", property: "case_name" },
							}),
							f({ id: "n", kind: "int" }),
							f({ id: "amount", kind: "decimal" }),
							f({ id: "words", kind: "text" }),
							f({ id: "visit", kind: "date" }),
							f({
								id: "many",
								kind: "multi_select",
								optionsSource: inline("many", ["1", "2"]),
							}),
							f({ id: "untyped", kind: "hidden" }),
							f({
								id: "pick",
								kind: "single_select",
								optionsSource: inline("pick", integerChoices),
							}),
							f({
								id: "from_table",
								kind: "single_select",
								optionsSource: {
									kind: "lookup",
									tableId: "018f3e8a-7b2c-7def-8abc-1234567890ab",
									valueColumnId: "018f3e8a-7b2c-7def-8abc-1234567890ad",
									labelColumnId: "018f3e8a-7b2c-7def-8abc-1234567890ae",
								},
							}),
							f({
								id: "from_cases",
								kind: "single_select",
								optionsSource: {
									kind: "cases",
									caseType: "household",
									labelProperty: "case_name",
								},
							}),
							f({
								uuid: ids.count,
								id: "members",
								kind: "repeat",
								repeat_mode: "count_bound",
								repeat_count: count,
								children: [f({ id: "member", kind: "text" })],
							}),
							f({
								uuid: ids.reader,
								id: "total",
								kind: "hidden",
								calculate: countRead,
							}),
						],
					},
				],
			},
		],
	});
}

const countSlot: ExpressionSlotRef = {
	entity: "field",
	uuid: ids.count,
	slot: "repeat_count",
};

function check(source: string, integerChoices = ["1", "2"]) {
	const doc = countDoc(integerChoices);
	const ctx = slotContext(doc, countSlot, new Map());
	if (ctx === undefined)
		throw new Error("The count fixture has no count slot.");
	return checkExpression(parseFixtureExpression(doc, countSlot, source), ctx)
		.errors;
}
const reasons = (errors: readonly { code: string; reason?: string }[]) =>
	errors.map((error) => `${error.code}:${error.reason ?? ""}`);

describe("a repeat count is a whole number", () => {
	it("gives the count slot the repeat-count expectation", () => {
		const ctx = slotContext(countDoc(["1", "2"]), countSlot, new Map());
		expect(ctx?.profile.expectation).toEqual({ kind: "repeat-count" });
	});

	it.each([
		"2",
		"int(#form/amount)",
		"count(#form/many)",
		"#form/n",
		"#form/n + 1",
		"round(#form/amount)",
		"number(#form/n)",
	])("admits %s", (source) => {
		expect(check(source)).toEqual([]);
	});

	it.each([
		["#form/n div 2", "decimal"],
		["#form/amount", "decimal"],
		["#form/words", "text"],
		["number(#form/words)", "decimal"],
		["#form/many", "multi_select"],
		["#form/visit", "date"],
		["#form/untyped", "_any"],
	])("refuses %s as a count that can be %s", (source, type) => {
		const errors = check(source);
		expect(reasons(errors)).toEqual(["expected-value:whole-number-count"]);
		expect(errors[0]?.repeatCount).toEqual({ type });
	});

	it("admits 2.0, which the parser stores as the number 2", () => {
		// The literal holds a number, not its spelling, and prints as `2`.
		expect(check("2.0")).toEqual([]);
	});

	it("words each refused type for a person", () => {
		expect(check("#form/amount")[0]?.message).toContain("a decimal number");
		expect(check("#form/many")[0]?.message).toContain("a list of choices");
		expect(check("#form/untyped")[0]?.message).toContain("any kind of value");
		expect(check("#form/untyped")[0]?.message).toContain("int(...)");
	});

	it.each([
		["#form/from_table", "lookup", "a data table"],
		["#form/from_cases", "cases", "the worker's cases"],
	])(
		"refuses %s, whose choices Nova cannot prove whole",
		(source, kind, words) => {
			const errors = check(source);
			expect(reasons(errors)).toEqual(["expected-value:count-choices-unknown"]);
			expect(errors[0]?.repeatCount).toMatchObject({ source: kind });
			expect(errors[0]?.message).toContain(words);
		},
	);

	it("admits a single select whose choices are 1, +5, 007 and -3", () => {
		expect(check("#form/pick", ["1", "+5", "007", "-3"])).toEqual([]);
	});

	it("admits the extremes of Java's int range", () => {
		expect(check("#form/pick", ["2147483647", "-2147483648"])).toEqual([]);
	});

	it.each([
		["2147483648"],
		["-2147483649"],
		["1.0"],
		// Arabic-Indic three: `Integer.parseInt` reads it, Nova admits ASCII only.
		["٣"],
		["1e3"],
	])("refuses a single select with the choice %s", (value) => {
		const errors = check("#form/pick", ["1", value]);
		expect(reasons(errors)).toEqual(["expected-value:count-choice-not-whole"]);
		expect(errors[0]?.repeatCount).toMatchObject({
			selectId: "pick",
			value,
		});
		expect(errors[0]?.message).toContain(`"${value}"`);
	});

	it("names the first choice that isn't whole", () => {
		expect(
			check("#form/pick", ["1", "half", "1.5"])[0]?.repeatCount?.value,
		).toBe("half");
	});

	it("admits an integer select read in every spelling", () => {
		for (const source of ["#form/pick", "/data/pick", "../pick"])
			expect(check(source, ["1", "2"])).toEqual([]);
	});

	it("refuses a not-whole select in every spelling", () => {
		for (const source of ["#form/pick", "/data/pick", "../pick"])
			expect(reasons(check(source, ["1", "1.5"]))).toEqual([
				"expected-value:count-choice-not-whole",
			]);
	});

	it("checks a select's choices only where the count is the bare read", () => {
		// `concat` makes it text, whatever the choices.
		expect(reasons(check("concat(#form/pick, '')", ["1", "2"]))).toEqual([
			"expected-value:whole-number-count",
		]);
	});

	it("raises nothing more over an expression an earlier error left unresolved", () => {
		const doc = countDoc(["1", "2"]);
		const ctx = slotContext(doc, countSlot, new Map());
		if (ctx === undefined)
			throw new Error("The count fixture has no count slot.");
		const errors = checkExpression(
			{
				kind: "term",
				term: { kind: "field", uuid: testUuid("repeat-count-missing") },
			},
			ctx,
		).errors;
		expect(errors.length).toBeGreaterThan(0);
		expect(errors.some((error) => error.code === "expected-value")).toBe(false);
	});

	it("types a read of a count repeat's count as int", () => {
		// The count reads an integer select, whose own type is a choice.
		const doc = countDoc(["1", "2"], "#form/pick");
		const slot: ExpressionSlotRef = {
			entity: "field",
			uuid: ids.reader,
			slot: "calculate",
		};
		const ctx = slotContext(doc, slot, new Map());
		if (ctx === undefined) throw new Error("The reader has no calculate slot.");
		expect(checkExpression(countRead, ctx).errors).toEqual([]);
		expect(typeOf(countRead, ctx)?.data).toEqual(
			expect.objectContaining({ nodes: "int" }),
		);
	});
});
