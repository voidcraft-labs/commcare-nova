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
