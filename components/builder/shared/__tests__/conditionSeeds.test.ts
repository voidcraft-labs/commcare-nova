import { describe, expect, it } from "vitest";
import { expressionEditorFixture } from "@/__tests__/helpers/expressionEditorFixture";
import { testUuid } from "@/__tests__/helpers/uuid";
import type { CaseType } from "@/lib/domain";
import {
	ancestorPath,
	checkExpression,
	eq,
	exists,
	expressionContextAtPath,
	input,
	literal,
	matchAll,
	prop,
	relationStep,
	subcasePath,
	whenInput,
} from "@/lib/domain/expression";
import { proseText } from "@/lib/domain/prose";
import { whenInputPresentDefault } from "../cards/WhenInputPresentCard";
import { relatedConditionSeed } from "../conditionSeed";

const CASE_TYPES: readonly CaseType[] = [
	{
		name: "patient",
		parent_type: "household",
		properties: [
			{ name: "status", label: proseText("Status"), data_type: "text" },
		],
	},
	{
		name: "household",
		properties: [
			{ name: "region", label: proseText("Region"), data_type: "text" },
		],
	},
];
const KNOWN_INPUTS = [
	{ uuid: testUuid("query"), name: "query", data_type: "text" },
] as const;
const PATIENT_FIRST = eq(prop("patient", "status"), literal(""));
const HOUSEHOLD_FIRST = eq(prop("household", "region"), literal(""));
const RELATION_ONLY_CASE_TYPES: readonly CaseType[] = [
	{ name: "household", properties: [] },
	{ name: "visit", parent_type: "household", properties: [] },
	{ name: "patient", parent_type: "household", properties: [] },
];
const RELATION_ONLY_FIRST = exists(subcasePath("parent", "visit"));
const EMPTY_CASE_TYPES: readonly CaseType[] = [
	{ name: "orphan", properties: [] },
];

describe("actual structural condition seeds", () => {
	it("starts a new search-answer wrapper with an editable Is condition", () => {
		expect(
			whenInputPresentDefault(
				expressionEditorFixture("case-filter", {
					caseTypes: CASE_TYPES,
					currentCaseType: "patient",
					knownInputs: KNOWN_INPUTS,
					caseDataScope: "per-case",
				}).context,
			),
		).toEqual(whenInput(input(testUuid("query")), PATIENT_FIRST));
	});

	it("derives the related row through the owning expression slot", () => {
		const ctx = expressionEditorFixture("case-filter", {
			caseTypes: CASE_TYPES,
			currentCaseType: "patient",
			knownInputs: [],
			caseDataScope: "per-case",
		}).context;
		const via = ancestorPath(relationStep("parent", "household"));
		const seed = relatedConditionSeed(ctx, "household", via);
		expect(seed).toEqual(HOUSEHOLD_FIRST);
		if (seed === undefined) throw new Error("Expected available condition");
		const nested = expressionContextAtPath(
			exists(via, matchAll()),
			ctx.expressionContext,
			["exists", "where"],
		);
		if (nested === undefined) throw new Error("Expected a related row context");
		expect(checkExpression(seed, nested)).toMatchObject({ errors: [] });
	});
	it("offers a real relation where the destination has no own properties", () => {
		expect(
			relatedConditionSeed(
				expressionEditorFixture("case-filter", {
					caseDataScope: "per-case",
					caseTypes: RELATION_ONLY_CASE_TYPES,
					currentCaseType: "patient",
					knownInputs: [],
				}).context,
				"household",
				ancestorPath(relationStep("parent", "household")),
			),
		).toEqual(RELATION_ONLY_FIRST);
	});
	it("refuses an unresolved destination or an empty isolated catalog", () => {
		const ctx = expressionEditorFixture("case-filter", {
			caseDataScope: "per-case" as const,
			caseTypes: EMPTY_CASE_TYPES,
			currentCaseType: "orphan",
			knownInputs: [],
		}).context;
		expect(
			relatedConditionSeed(ctx, undefined, subcasePath("parent", "missing")),
		).toBeUndefined();
		expect(
			relatedConditionSeed(ctx, "orphan", subcasePath("parent", "orphan")),
		).toBeUndefined();
	});
});
