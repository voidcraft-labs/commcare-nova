import { describe, expect, it } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import { buildDoc, caseListConfig } from "@/lib/__tests__/docHelpers";
import {
	advancedSearchInputDef,
	type CaseType,
	calculatedColumn,
} from "@/lib/domain";
import {
	ancestorPath,
	anyRelationPath,
	dateAdd,
	double,
	eq,
	ifExpr,
	literal,
	matchAll,
	now,
	prop,
	relationStep,
	subcasePath,
	term,
	today,
} from "@/lib/domain/expression/builders";
import { slotContext } from "@/lib/domain/expression/context";
import type { ExpressionSlotRef } from "@/lib/domain/expression/types";
import { proseText } from "@/lib/domain/prose";
import { expressionEditVerdict } from "../commitVerdicts";

const MODULE = testUuid("runtime-verdict-module");
const COLUMN = testUuid("runtime-verdict-column");
const INPUT = testUuid("runtime-verdict-input");
function contextFor(
	carrier:
		| "device-value"
		| "device-condition"
		| "search-condition"
		| "shared-condition"
		| "search-column",
	caseTypes: readonly CaseType[],
	caseType = "patient",
) {
	const doc = buildDoc({
		caseTypes: [...caseTypes],
		modules: [
			{
				uuid: MODULE,
				name: "Records",
				caseType,
				caseListOnly: true,
				caseListConfig: {
					...caseListConfig([]),
					columns: [calculatedColumn(COLUMN, "Value", term(literal("")))],
					listColumnOrder: [COLUMN],
					detailColumnOrder: [COLUMN],
					searchInputs:
						carrier === "search-condition"
							? [
									advancedSearchInputDef(
										INPUT,
										"answer",
										"Answer",
										"text",
										matchAll(),
									),
								]
							: [],
				},
				...(carrier.startsWith("search") || carrier === "shared-condition"
					? { caseSearchConfig: {} }
					: {}),
			},
		],
	});
	const slot: ExpressionSlotRef =
		carrier === "search-condition"
			? {
					entity: "module",
					uuid: MODULE,
					slot: "search_input_predicate",
					member: { searchInputUuid: INPUT },
				}
			: carrier === "device-value" || carrier === "search-column"
				? {
						entity: "module",
						uuid: MODULE,
						slot: "case_list_column_expression",
						member: { columnUuid: COLUMN },
					}
				: { entity: "module", uuid: MODULE, slot: "case_list_filter" };
	const context = slotContext(doc, slot, new Map());
	if (context === undefined)
		throw new Error("The fixture has no expression slot.");
	return context;
}

const CASE_TYPES: CaseType[] = [
	{
		name: "patient",
		properties: [
			{ name: "dob", label: proseText("Date of birth"), data_type: "date" },
			{
				name: "last_seen",
				label: proseText("Last seen"),
				data_type: "datetime",
			},
		],
	},
];

const quantity = term(literal(1));

describe("expression runtime edit verdicts", () => {
	it("rejects calendar intervals and datetime bases for on-device carriers", () => {
		expect(
			expressionEditVerdict(
				eq(prop("patient", "dob"), dateAdd(today(), "months", quantity)),
				contextFor("device-condition", CASE_TYPES),
			),
		).toMatchObject({ ok: false, reason: expect.stringContaining("Month") });
		expect(
			expressionEditVerdict(
				dateAdd(now(), "days", quantity),
				contextFor("device-value", CASE_TYPES),
			),
		).toMatchObject({
			ok: false,
			reason: expect.stringContaining("time would be lost"),
		});
	});

	it("resolves case property types before accepting device date arithmetic", () => {
		expect(
			expressionEditVerdict(
				dateAdd(term(prop("patient", "dob")), "days", quantity),
				contextFor("device-value", CASE_TYPES),
			),
		).toEqual({ ok: true });
		expect(
			expressionEditVerdict(
				dateAdd(term(prop("patient", "last_seen")), "days", quantity),
				contextFor("device-value", CASE_TYPES),
			),
		).toMatchObject({
			ok: false,
			reason: expect.stringContaining("time would be lost"),
		});
	});

	it("keeps direct native date arithmetic available in a server search", () => {
		expect(
			expressionEditVerdict(
				eq(prop("patient", "dob"), dateAdd(today(), "months", quantity)),
				contextFor("search-condition", CASE_TYPES),
			),
		).toEqual({ ok: true });
		expect(
			expressionEditVerdict(
				eq(prop("patient", "last_seen"), dateAdd(now(), "years", quantity)),
				contextFor("search-condition", CASE_TYPES),
			),
		).toEqual({ ok: true });
	});

	it("still rejects a server-search subtree that is interpolated on device", () => {
		const calculated = ifExpr(
			matchAll(),
			dateAdd(today(), "years", quantity),
			today(),
		);
		expect(
			expressionEditVerdict(
				eq(prop("patient", "dob"), calculated),
				contextFor("search-condition", CASE_TYPES),
			),
		).toMatchObject({ ok: false, reason: expect.stringContaining("Month") });
	});

	it("uses the strict intersection when one rule runs in both runtimes", () => {
		expect(
			expressionEditVerdict(
				eq(prop("patient", "dob"), dateAdd(today(), "months", quantity)),
				contextFor("shared-condition", CASE_TYPES),
			),
		).toMatchObject({ ok: false, reason: expect.stringContaining("Month") });
	});
});

describe("Search calculated-expression edit verdict", () => {
	const relatedTypes: CaseType[] = [
		{
			name: "household",
			properties: [
				{
					name: "score",
					label: proseText("Score"),
					data_type: "int",
				},
			],
		},
		{
			name: "patient",
			parent_type: "household",
			properties: [{ name: "age", label: proseText("Age"), data_type: "int" }],
		},
	];
	const context = contextFor("search-column", relatedTypes);

	it("keeps current-case calculations and one whole ancestor property available", () => {
		expect(
			expressionEditVerdict(double(term(prop("patient", "age"))), context),
		).toEqual({ ok: true });
		expect(
			expressionEditVerdict(
				term(
					prop(
						"patient",
						"score",
						ancestorPath(relationStep("parent", "household")),
					),
				),
				context,
			),
		).toEqual({ ok: true });
		expect(
			expressionEditVerdict(
				term(prop("patient", "score", anyRelationPath("parent", "household"))),
				context,
			),
		).toEqual({ ok: true });
	});

	it("rejects wrapped parent reads and unaggregated child reads with a concrete repair", () => {
		const directParent = term(
			prop(
				"patient",
				"score",
				ancestorPath(relationStep("parent", "household")),
			),
		);
		const wrapped = expressionEditVerdict(double(directParent), context);
		expect(wrapped).toMatchObject({
			ok: false,
			reason: expect.stringContaining("Choose the parent property by itself"),
		});
		expect(
			expressionEditVerdict(
				term(prop("household", "age", subcasePath("parent", "patient"))),
				contextFor("search-column", relatedTypes, "household"),
			),
		).toMatchObject({
			ok: false,
			reason: expect.stringContaining("Choose the parent property by itself"),
		});
	});
});
