// lib/commcare/__tests__/countReference.test.ts
//
// Which repeat counts `jr:count` names directly and which take the generated
// `nova_count_<repeat>` carrier. Core reads a count as
// `IntegerData().cast(count.uncast())`, so a direct count must name a node
// whose text is always a whole number: an int question, a single select
// whose inline choices are whole numbers, or a Hidden Value calculated as an
// int (a calculate's integral result is `IntegerData` whatever the bind,
// `Recalculate.java::wrapData`). A Hidden Value holding only a starting value
// is cast into its bind by a setvalue and can read `3.0`, so it keeps the
// carrier. The facts come from the production inference over built
// documents. Plausible failures: a default-only Hidden Value or a decimal
// calculate named directly (Core stops the form), a relative read named
// directly (it loses its evaluation context), or a read count dropping its
// carrier.

import { describe, expect, it } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import { buildDoc, f } from "@/lib/__tests__/docHelpers";
import type { BlueprintDoc } from "@/lib/domain";
import {
	expressionFacts,
	referencedCountResults,
} from "@/lib/domain/expression/context";
import {
	type FormStructure,
	formStructure,
} from "@/lib/domain/expression/formStructure";
import type { Expression, FieldSpelling } from "@/lib/domain/expression/types";
import {
	directRepeatCountReference,
	planRepeatCountCarriers,
} from "@/lib/domain/repeatCount";
import { planRepeatCountNames } from "../xform/repeatCountNames";

const ids = Object.fromEntries(
	[
		"form",
		"n",
		"amount",
		"pick",
		"loose",
		"table",
		"calc_int",
		"calc_dec",
		"seed",
		"rows",
		"reader",
	].map((name) => [name, testUuid(`count-reference-${name}`)]),
) as Record<string, ReturnType<typeof testUuid>>;

const inline = (field: string, values: readonly string[]) => ({
	kind: "inline",
	options: values.map((value, index) => ({
		uuid: testUuid(`count-reference-choice-${field}-${index}`),
		value,
		label: `Choice ${index + 1}`,
	})),
});

/** A survey holding every kind of field a count might read, and a count
 * repeat whose count is `count`; with `readCount`, a Hidden Value that reads
 * the repeat's count. */
function countDoc(count: string, readCount = false): BlueprintDoc {
	return buildDoc({
		appName: "Counts",
		modules: [
			{
				name: "Visits",
				forms: [
					{
						uuid: ids.form,
						name: "Visit",
						type: "survey",
						fields: [
							f({ uuid: ids.n, id: "n", kind: "int" }),
							f({ uuid: ids.amount, id: "amount", kind: "decimal" }),
							f({
								uuid: ids.pick,
								id: "pick",
								kind: "single_select",
								optionsSource: inline("pick", ["1", "+5", "-3"]),
							}),
							f({
								uuid: ids.loose,
								id: "loose",
								kind: "single_select",
								optionsSource: inline("loose", ["1", "1.5"]),
							}),
							f({
								uuid: ids.table,
								id: "table",
								kind: "single_select",
								optionsSource: {
									kind: "lookup",
									tableId: "018f3e8a-7b2c-7def-8abc-1234567890ab",
									valueColumnId: "018f3e8a-7b2c-7def-8abc-1234567890ad",
									labelColumnId: "018f3e8a-7b2c-7def-8abc-1234567890ae",
								},
							}),
							f({
								uuid: ids.calc_int,
								id: "calc_int",
								kind: "hidden",
								calculate: "int(#form/amount)",
							}),
							f({
								uuid: ids.calc_dec,
								id: "calc_dec",
								kind: "hidden",
								calculate: "#form/amount",
							}),
							f({
								uuid: ids.seed,
								id: "seed",
								kind: "hidden",
								default_value: "3",
							}),
							f({
								uuid: ids.rows,
								id: "rows",
								kind: "repeat",
								repeat_mode: "count_bound",
								repeat_count: count,
								children: [f({ id: "note", kind: "text" })],
							}),
							...(readCount
								? [
										f({
											uuid: ids.reader,
											id: "reader",
											kind: "hidden",
											calculate: {
												kind: "term",
												term: {
													kind: "form-node",
													node: {
														kind: "repeat",
														repeat: ids.rows,
														role: "count-result",
													},
													spelling: "relative",
												},
											},
										}),
									]
								: []),
						],
					},
				],
			},
		],
	});
}

function structureOf(doc: BlueprintDoc): FormStructure {
	const form = formStructure(doc, ids.form);
	if (form === undefined) throw new Error("The count fixture has no form.");
	return form;
}

const read = (uuid: string, spelling?: FieldSpelling): Expression => ({
	kind: "term",
	term: {
		kind: "field",
		uuid: uuid as never,
		...(spelling === undefined ? {} : { spelling }),
	},
});

describe("a direct repeat count", () => {
	// One document stands for the form; each case asks about one count tree.
	const doc = countDoc("2");
	const form = structureOf(doc);
	const facts = expressionFacts(doc);
	const direct = (expression: Expression) =>
		directRepeatCountReference(expression, form, facts);

	it.each([
		["an int question", "n"],
		["a single select whose inline choices are whole numbers", "pick"],
		["a Hidden Value calculated as an int", "calc_int"],
	])("names %s directly, spelled with a hashtag or a path", (_, name) => {
		expect(direct(read(ids[name]))).toBe(ids[name]);
		expect(direct(read(ids[name], "absolute"))).toBe(ids[name]);
	});

	it.each([
		["a decimal question", "amount"],
		["a single select with a choice that isn't whole", "loose"],
		["a single select whose choices come from a data table", "table"],
		["a Hidden Value calculated as a decimal", "calc_dec"],
		["a Hidden Value holding only a starting value", "seed"],
	])("gives %s the carrier", (_, name) => {
		expect(direct(read(ids[name]))).toBeUndefined();
	});

	it("keeps the carrier for a relative or current() read of an int question", () => {
		expect(direct(read(ids.n, "relative"))).toBeUndefined();
		expect(direct(read(ids.n, "current"))).toBeUndefined();
	});

	it("keeps the carrier for a filtered read and for an expression", () => {
		expect(
			direct({
				kind: "term",
				term: {
					kind: "field",
					uuid: ids.n,
					filters: [
						{
							step: { kind: "field", uuid: ids.n },
							where: [{ kind: "match-all" }],
						},
					],
				},
			}),
		).toBeUndefined();
		expect(
			direct({
				kind: "arith",
				op: "+",
				left: read(ids.n),
				right: { kind: "term", term: { kind: "literal", value: 1 } },
			}),
		).toBeUndefined();
	});

	it("reads the Hidden Values' types from the production inference", () => {
		expect(facts.hiddenTypes.get(ids.calc_int)).toBe("int");
		expect(facts.hiddenTypes.get(ids.calc_dec)).toBe("decimal");
	});
});

describe("count carriers", () => {
	it("reserves every potential carrier name without reading an expression", () => {
		const doc = countDoc("#form/n");
		const form = structureOf(doc);
		const names = planRepeatCountNames({
			...form,
			expressionAt: () => {
				throw new Error("Names cannot depend on expression parsing.");
			},
		});
		expect(names.get(ids.rows)).toBe("nova_count_rows");
	});

	it("names a direct count with no carrier until another expression reads the count", () => {
		const unread = countDoc("#form/calc_int");
		expect(
			planRepeatCountCarriers(
				structureOf(unread),
				referencedCountResults(unread, ids.form),
				expressionFacts(unread),
			).forRepeat(ids.rows),
		).toEqual({
			expression: read(ids.calc_int),
			directReference: ids.calc_int,
			materialized: false,
		});
		const readDoc = countDoc("#form/calc_int", true);
		expect(
			planRepeatCountCarriers(
				structureOf(readDoc),
				referencedCountResults(readDoc, ids.form),
				expressionFacts(readDoc),
			).forRepeat(ids.rows),
		).toMatchObject({ directReference: ids.calc_int, materialized: true });
	});

	it("materializes the carrier of every count that is not direct", () => {
		const doc = countDoc("#form/seed");
		const carrier = planRepeatCountCarriers(
			structureOf(doc),
			referencedCountResults(doc, ids.form),
			expressionFacts(doc),
		).forRepeat(ids.rows);
		expect(carrier?.directReference).toBeUndefined();
		expect(carrier?.materialized).toBe(true);
	});

	it("plans nothing for a field that is not a count repeat, and reads lazily", () => {
		const doc = countDoc("2");
		const form = structureOf(doc);
		const reads: string[] = [];
		const plan = planRepeatCountCarriers(
			{
				...form,
				expressionAt: (slot) => {
					reads.push(slot.uuid);
					return form.expressionAt(slot);
				},
			},
			new Set(),
			expressionFacts(doc),
		);
		expect(reads).toEqual([]);
		expect(plan.forRepeat(ids.n)).toBeUndefined();
		expect(reads).toEqual([]);
		plan.forRepeat(ids.rows);
		plan.forRepeat(ids.rows);
		expect(reads).toEqual([ids.rows]);
	});
});
