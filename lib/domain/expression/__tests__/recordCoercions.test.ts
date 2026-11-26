// The two record-rule widenings CommCare's own evaluation decides, held at
// the checker over real slots: a read standing as a condition where CommCare
// holds a yes or no, and the `=` / `!=` / `in` comparisons Core coerces as
// their author means. Each admission sits beside the nearest shape the rule
// still refuses, so a widening that grew past its class fails here.

import { describe, expect, it } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import { buildDoc, caseListConfig, f } from "@/lib/__tests__/docHelpers";
import { type BlueprintDoc, calculatedColumn, type Uuid } from "@/lib/domain";
import { advancedSearchInputDef } from "@/lib/domain/modules";
import { proseText } from "@/lib/domain/prose";
import {
	and,
	concat,
	eq,
	formField,
	gt,
	ifExpr,
	isIn,
	literal,
	neq,
	not,
	prop,
	term,
} from "../builders";
import { slotContext } from "../context";
import { checkExpression } from "../typeChecker";
import type { Expression, ExpressionSlotRef } from "../types";

const MODULE = testUuid("record-coercions-module");
const SEARCH_MODULE = testUuid("record-coercions-search-module");
const FORM = testUuid("record-coercions-form");
const OPERATION = testUuid("record-coercions-operation");
const COLUMN = testUuid("record-coercions-column");
const INPUT = testUuid("record-coercions-input");
const FLAG = testUuid("record-coercions-flag");
const TEXT_HIDDEN = testUuid("record-coercions-text-hidden");
const NUMBER_HIDDEN = testUuid("record-coercions-number-hidden");
const NOTE = testUuid("record-coercions-note");
const CHOICE = testUuid("record-coercions-choice");

const SITE = {
	name: "site",
	properties: [
		{ name: "case_name", label: proseText("Name"), data_type: "text" as const },
		{ name: "repairs", label: proseText("Repairs"), data_type: "int" as const },
		{
			name: "weight",
			label: proseText("Weight"),
			data_type: "decimal" as const,
		},
		{ name: "note", label: proseText("Note"), data_type: "text" as const },
		{
			name: "cut_water",
			label: proseText("Cut water"),
			data_type: "single_select" as const,
			options: [
				{ value: "1", label: proseText("Yes") },
				{ value: "0", label: proseText("No") },
			],
		},
		{
			name: "tags",
			label: proseText("Tags"),
			data_type: "multi_select" as const,
			options: [{ value: "1", label: proseText("One") }],
		},
	],
};

/** A follow-up form whose create's condition is the slot under test, a
 *  browse list with one calculated column, and a searching list with one
 *  advanced Search field. */
function fixture(
	condition: Expression,
	column: Expression,
	search: Expression,
) {
	const doc = buildDoc({
		caseTypes: [SITE, { name: "referral", properties: [] }],
		modules: [
			{
				uuid: MODULE,
				name: "Sites",
				caseType: "site",
				caseListConfig: {
					...caseListConfig([]),
					columns: [calculatedColumn(COLUMN, "Work", column)],
					listColumnOrder: [COLUMN],
					detailColumnOrder: [COLUMN],
				},
				forms: [
					{
						uuid: FORM,
						name: "Inspection",
						type: "followup",
						fields: [
							f({ uuid: NOTE, kind: "text", id: "note", label: "Note" }),
							f({
								uuid: CHOICE,
								kind: "single_select",
								id: "choice",
								label: "Choice",
								options: [
									{ value: "1", label: "Yes" },
									{ value: "0", label: "No" },
								],
							}),
							f({
								uuid: FLAG,
								kind: "hidden",
								id: "create_referral",
								calculate: "#form/note != ''",
							}),
							f({
								uuid: TEXT_HIDDEN,
								kind: "hidden",
								id: "referral_text",
								calculate: "if(#form/note != '', '1', '0')",
							}),
							f({
								uuid: NUMBER_HIDDEN,
								kind: "hidden",
								id: "referral_count",
								calculate: "count(#form/note)",
							}),
						],
					},
				],
			},
			{
				uuid: SEARCH_MODULE,
				name: "Find sites",
				caseType: "site",
				caseListConfig: {
					...caseListConfig([]),
					searchInputs: [
						advancedSearchInputDef(INPUT, "kind", "Kind", "text", search),
					],
				},
				caseSearchConfig: {},
			},
		],
	});
	const withOperation: BlueprintDoc = {
		...doc,
		forms: {
			...doc.forms,
			[FORM]: {
				...doc.forms[FORM],
				caseOperations: [
					...(doc.forms[FORM].caseOperations ?? []),
					{
						uuid: OPERATION,
						id: "referral",
						action: "create",
						caseType: "referral",
						target: { kind: "new" },
						name: term(literal("Referral")),
						condition,
					},
				],
			},
		},
	};
	return withOperation;
}

const CONDITION_SLOT: ExpressionSlotRef = {
	entity: "form",
	uuid: FORM,
	slot: "case_operation_condition",
	member: { operationUuid: OPERATION },
};
const COLUMN_SLOT: ExpressionSlotRef = {
	entity: "module",
	uuid: MODULE,
	slot: "case_list_column_expression",
	member: { columnUuid: COLUMN },
};
const SEARCH_SLOT: ExpressionSlotRef = {
	entity: "module",
	uuid: SEARCH_MODULE,
	slot: "search_input_predicate",
	member: { searchInputUuid: INPUT },
};

const PLAIN = term(literal("x"));
const ALWAYS = eq(prop("site", "note"), literal("x"));

/** The findings of `expression` in `slot`, as `code:reason`. */
function findings(
	slot: ExpressionSlotRef,
	expression: Expression,
): readonly string[] {
	const doc = fixture(
		slot === CONDITION_SLOT ? expression : ALWAYS,
		slot === COLUMN_SLOT ? expression : PLAIN,
		slot === SEARCH_SLOT ? expression : ALWAYS,
	);
	const context = slotContext(doc, slot, new Map());
	if (context === undefined)
		throw new Error("The fixture holds no slot the test names.");
	return checkExpression(expression, context).errors.map((error) =>
		[error.code, error.reason].filter(Boolean).join(":"),
	);
}

const read = (uuid: Uuid) => term(formField(uuid));

describe("a read standing as a case change's condition", () => {
	it("stands where its value is a yes or no CommCare holds", () => {
		expect(findings(CONDITION_SLOT, read(FLAG))).toEqual([]);
		expect(findings(CONDITION_SLOT, not(read(FLAG)))).toEqual([]);
		expect(
			findings(CONDITION_SLOT, and(read(FLAG), eq(read(NOTE), literal("a")))),
		).toEqual([]);
	});

	it.each([
		["a text answer", NOTE],
		["a choice answer", CHOICE],
		["a Hidden Value calculated as text", TEXT_HIDDEN],
		["a Hidden Value calculated as a number", NUMBER_HIDDEN],
	])("is refused where it reads %s, which no yes or no holds", (_, uuid) => {
		expect(findings(CONDITION_SLOT, read(uuid))).toEqual([
			"record-position:condition-expected",
		]);
	});

	it.each([
		["a text answer", NOTE],
		["a choice answer", CHOICE],
		["a Hidden Value calculated as text", TEXT_HIDDEN],
		["a Hidden Value calculated as a number", NUMBER_HIDDEN],
		["a yes or no", FLAG],
	])(
		"stands through boolean(...) where it reads %s, true wherever the answer is not empty",
		(_, uuid) => {
			expect(
				findings(CONDITION_SLOT, {
					kind: "call",
					fn: "boolean",
					args: [read(uuid)],
				}),
			).toEqual([]);
		},
	);

	it("admits boolean(...) of a question alone, and no other call, in a record rule", () => {
		expect(
			findings(CONDITION_SLOT, {
				kind: "call",
				fn: "boolean",
				args: [term(prop("site", "note"))],
			}),
		).toEqual(["arm-unavailable:call"]);
		expect(
			findings(CONDITION_SLOT, {
				kind: "call",
				fn: "contains",
				args: [read(NOTE), term(literal("a"))],
			}),
		).toEqual(["arm-unavailable:call"]);
		expect(
			findings(COLUMN_SLOT, {
				kind: "call",
				fn: "boolean",
				args: [term(literal("a"))],
			}),
		).toEqual(["arm-unavailable:call"]);
	});

	it("is refused where it reads a case property, which a device holds as text", () => {
		expect(findings(CONDITION_SLOT, term(prop("site", "note")))).toEqual([
			"record-position:condition-expected",
		]);
	});
});

describe("the comparisons CommCare coerces", () => {
	const repairs = term(prop("site", "repairs"));
	const cutWater = term(prop("site", "cut_water"));

	it("admits a whole number against the text of one, as CommCare writes it", () => {
		expect(
			findings(COLUMN_SLOT, ifExpr(eq(repairs, literal("1")), PLAIN, PLAIN)),
		).toEqual([]);
		expect(
			findings(COLUMN_SLOT, ifExpr(neq(literal("-12"), repairs), PLAIN, PLAIN)),
		).toEqual([]);
		expect(
			findings(
				CONDITION_SLOT,
				isIn(prop("site", "repairs"), literal("0"), literal("1")),
			),
		).toEqual([]);
	});

	it.each(["01", "1.0", "+1", " 1", "-0", "2147483648", "one", ""])(
		"refuses a whole number against '%s', which a property's text never equals",
		(text) => {
			expect(
				findings(COLUMN_SLOT, ifExpr(eq(repairs, literal(text)), PLAIN, PLAIN)),
			).toEqual(["incompatible-values"]);
		},
	);

	it("refuses a decimal against the text of a whole number", () => {
		expect(
			findings(
				COLUMN_SLOT,
				ifExpr(eq(term(prop("site", "weight")), literal("1")), PLAIN, PLAIN),
			),
		).toEqual(["incompatible-values"]);
	});

	it("admits a choice or text against a number literal", () => {
		expect(
			findings(COLUMN_SLOT, ifExpr(eq(cutWater, literal(1)), PLAIN, PLAIN)),
		).toEqual([]);
		expect(
			findings(
				COLUMN_SLOT,
				ifExpr(neq(literal(1.5), term(prop("site", "note"))), PLAIN, PLAIN),
			),
		).toEqual([]);
		expect(
			findings(
				CONDITION_SLOT,
				isIn(prop("site", "cut_water"), literal(1), literal(0)),
			),
		).toEqual([]);
	});

	it("refuses a list of choices, and a computed number, against the other side", () => {
		expect(
			findings(
				COLUMN_SLOT,
				ifExpr(eq(term(prop("site", "tags")), literal(1)), PLAIN, PLAIN),
			),
		).toEqual(["incompatible-values"]);
		expect(
			findings(
				COLUMN_SLOT,
				ifExpr(eq(cutWater, term(prop("site", "repairs"))), PLAIN, PLAIN),
			),
		).toEqual(["incompatible-values"]);
	});

	it("keeps refusing an ordering", () => {
		expect(
			findings(COLUMN_SLOT, ifExpr(gt(cutWater, literal(0)), PLAIN, PLAIN)),
		).toEqual(["ordered-values"]);
	});

	it("refuses either in a condition CommCare HQ's search reads, by its own reason", () => {
		expect(findings(SEARCH_SLOT, eq(cutWater, literal(1)))).toEqual([
			"incompatible-values:search-coercion",
		]);
		expect(findings(SEARCH_SLOT, eq(repairs, literal("1")))).toEqual([
			"incompatible-values:search-coercion",
		]);
	});

	it("leaves a concat of the two untouched, since it compares nothing", () => {
		expect(findings(COLUMN_SLOT, concat(cutWater, term(literal(1))))).toEqual(
			[],
		);
	});
});
