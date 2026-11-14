import { describe, expect, it } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import { buildDoc } from "@/lib/__tests__/docHelpers";
import { eq, literal, term } from "../expression/builders";
import type { ExpressionSlotRef } from "../expression/types";
import {
	expressionSlotKey,
	expressionSlotValue,
	expressionSlotValues,
} from "../referenceSlots";

const MODULE = testUuid("slot-module");
const FORM = testUuid("slot-form");
const FIELD = testUuid("slot-field");
const LINK = testUuid("slot-link");
const OPERATION = testUuid("slot-operation");

function fixture() {
	const doc = buildDoc({
		modules: [
			{
				uuid: MODULE,
				name: "Records",
				caseType: "record",
				forms: [
					{
						uuid: FORM,
						name: "Visit",
						type: "followup",
						fields: [
							{
								uuid: FIELD,
								id: "note",
								kind: "text",
								relevant: eq(literal(1), literal(1)),
							},
						],
					},
				],
			},
		],
	});
	doc.forms[FORM].formLinks = [
		{
			uuid: LINK,
			target: { type: "form", moduleUuid: MODULE, formUuid: FORM },
			datums: [
				{
					name: { kind: "selected-case", module: MODULE },
					xpath: term(literal("case-id")),
				},
			],
		},
	];
	doc.forms[FORM].caseOperations = [
		{
			uuid: OPERATION,
			id: "save",
			action: "update",
			caseType: "record",
			target: { kind: "session" },
			writes: [
				{ property: "first", value: term(literal("first-value")) },
				{ property: "second", value: term(literal("second-value")) },
			],
		},
	];
	return doc;
}

describe("expression slot addresses", () => {
	it("names nested members by identity and reads the same value after reordering", () => {
		const doc = fixture();
		const first: ExpressionSlotRef = {
			entity: "form",
			uuid: FORM,
			slot: "case_operation_write_value",
			member: { operationUuid: OPERATION, property: "first" },
		};
		const second: ExpressionSlotRef = {
			entity: "form",
			uuid: FORM,
			slot: "case_operation_write_value",
			member: { operationUuid: OPERATION, property: "second" },
		};
		const before = expressionSlotValues(doc, { entity: "form", uuid: FORM });
		expect(before.map(({ ref }) => expressionSlotKey(ref))).toEqual(
			expect.arrayContaining([
				expressionSlotKey(first),
				expressionSlotKey(second),
			]),
		);
		// The key path carries each collection position the walk chose.
		const pathOf = (ref: ExpressionSlotRef) =>
			expressionSlotValues(doc, { entity: "form", uuid: FORM }).find(
				(value) => expressionSlotKey(value.ref) === expressionSlotKey(ref),
			)?.path;
		expect(pathOf(second)).toEqual(["caseOperations", 0, "writes", 1, "value"]);
		doc.forms[FORM].caseOperations?.[0].writes?.reverse();
		expect(pathOf(second)).toEqual(["caseOperations", 0, "writes", 0, "value"]);
		expect(expressionSlotValue(doc, first)).toEqual(
			term(literal("first-value")),
		);
		expect(expressionSlotValue(doc, second)).toEqual(
			term(literal("second-value")),
		);
	});

	it("compares typed datum identity independently of object identity", () => {
		const doc = fixture();
		const ref: ExpressionSlotRef = {
			entity: "form",
			uuid: FORM,
			slot: "form_link_datum_xpath",
			member: {
				linkUuid: LINK,
				datum: { kind: "selected-case", module: MODULE },
			},
		};
		expect(expressionSlotValue(doc, ref)).toEqual(term(literal("case-id")));
		expect(
			expressionSlotValues(doc, { entity: "form", uuid: FORM }).some(
				({ ref: address }) =>
					expressionSlotKey(address) === expressionSlotKey(ref),
			),
		).toBe(true);
	});

	it("distinguishes absent optional expressions from nonexistent members without inventing values", () => {
		const doc = fixture();
		expect(
			expressionSlotValue(doc, {
				entity: "field",
				uuid: FIELD,
				slot: "required",
			}),
		).toBeUndefined();
		expect(
			expressionSlotValue(doc, {
				entity: "form",
				uuid: FORM,
				slot: "case_operation_write_value",
				member: { operationUuid: OPERATION, property: "missing" },
			}),
		).toBeUndefined();
		expect(
			expressionSlotValues(doc, { entity: "field", uuid: FIELD }).map(
				({ ref }) => ref.slot,
			),
		).toEqual(["relevant"]);
	});
});

describe("calculated values in prose", () => {
	const SELECT = testUuid("slot-prose-select");
	const RED = testUuid("slot-prose-red");
	const BLUE = testUuid("slot-prose-blue");
	const value = (literalText: string) => ({
		kind: "value" as const,
		expression: term(literal(literalText)),
	});
	function proseFixture() {
		return buildDoc({
			modules: [
				{
					uuid: MODULE,
					name: "Records",
					caseType: "record",
					forms: [
						{
							uuid: FORM,
							name: "Visit",
							type: "followup",
							fields: [
								{
									uuid: SELECT,
									id: "colour",
									kind: "single_select",
									relevant: eq(literal(1), literal(1)),
									label: {
										parts: [
											value("label-first"),
											{ kind: "text", text: " and " },
											value("label-second"),
										],
									},
									hint: { parts: [value("hint")] },
									optionsSource: {
										kind: "inline",
										options: [
											{
												uuid: RED,
												value: "red",
												label: { parts: [value("red")] },
											},
											{
												uuid: BLUE,
												value: "blue",
												label: { parts: [value("blue")] },
											},
										],
									},
								},
							],
						},
					],
				},
			],
		});
	}

	it("yields each value under its prose slot, after the expression slots, in slot and part order", () => {
		const values = expressionSlotValues(proseFixture(), {
			entity: "field",
			uuid: SELECT,
		});
		expect(
			values.map(({ ref, expression, path }) => ({
				slot: ref.slot,
				option: "member" in ref ? ref.member : undefined,
				expression,
				path,
			})),
		).toEqual([
			{
				slot: "relevant",
				option: undefined,
				expression: eq(literal(1), literal(1)),
				path: ["relevant"],
			},
			{
				slot: "label",
				option: undefined,
				expression: term(literal("label-first")),
				path: ["label", "parts", 0, "expression"],
			},
			{
				slot: "label",
				option: undefined,
				expression: term(literal("label-second")),
				path: ["label", "parts", 2, "expression"],
			},
			{
				slot: "hint",
				option: undefined,
				expression: term(literal("hint")),
				path: ["hint", "parts", 0, "expression"],
			},
			{
				slot: "option_label",
				option: { optionUuid: RED },
				expression: term(literal("red")),
				path: [
					"optionsSource",
					"options",
					0,
					"label",
					"parts",
					0,
					"expression",
				],
			},
			{
				slot: "option_label",
				option: { optionUuid: BLUE },
				expression: term(literal("blue")),
				path: [
					"optionsSource",
					"options",
					1,
					"label",
					"parts",
					0,
					"expression",
				],
			},
		]);
	});

	it("keys a prose slot apart from every expression slot and each option's label apart", () => {
		const keys = expressionSlotValues(proseFixture(), {
			entity: "field",
			uuid: SELECT,
		}).map(({ ref }) => expressionSlotKey(ref));
		const relevant = keys[0];
		const label = keys[1];
		const red = keys[4];
		const blue = keys[5];
		expect(new Set([relevant, label, keys[3], red, blue]).size).toBe(5);
		// Two values of one text share their slot's key.
		expect(keys[2]).toBe(label);
	});
});
