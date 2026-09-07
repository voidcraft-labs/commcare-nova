import { describe, expect, it } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import type { CaseType } from "@/lib/domain";
import {
	checkPredicate,
	eq,
	exists,
	input,
	literal,
	prop,
	subcasePath,
	whenInput,
} from "@/lib/domain/predicate";
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
			whenInputPresentDefault({
				caseTypes: CASE_TYPES,
				currentCaseType: "patient",
				knownInputs: KNOWN_INPUTS,
				caseDataScope: "per-case",
			}),
		).toEqual(whenInput(input(testUuid("query")), PATIENT_FIRST));
	});

	it("resolves nested row scope under a global mounting surface", () => {
		const seed = relatedConditionSeed(
			{
				caseTypes: CASE_TYPES,
				currentCaseType: "patient",
				knownInputs: KNOWN_INPUTS,
				caseDataScope: "global",
			},
			"household",
		);
		expect(seed).toEqual(HOUSEHOLD_FIRST);
		if (seed === undefined) throw new Error("Expected available condition");
		expect(
			checkPredicate(seed, {
				caseTypes: [...CASE_TYPES],
				currentCaseType: "household",
				knownInputs: [...KNOWN_INPUTS],
			}),
		).toEqual({ ok: true });
	});
	it("offers a real relation where the destination has no own properties", () => {
		expect(
			relatedConditionSeed(
				{
					caseDataScope: "per-case",
					caseTypes: RELATION_ONLY_CASE_TYPES,
					currentCaseType: "patient",
					knownInputs: [],
				},
				"household",
			),
		).toEqual(RELATION_ONLY_FIRST);
	});
	it("refuses an unresolved destination or an empty isolated catalog", () => {
		const ctx = {
			caseDataScope: "per-case" as const,
			caseTypes: EMPTY_CASE_TYPES,
			currentCaseType: "orphan",
			knownInputs: [],
		};
		expect(relatedConditionSeed(ctx, undefined)).toBeUndefined();
		expect(relatedConditionSeed(ctx, "orphan")).toBeUndefined();
	});
});
