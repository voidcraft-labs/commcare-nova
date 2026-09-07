import { describe, expect, it } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import { type SearchInputMode, simpleSearchInputDef } from "@/lib/domain";
import { ancestorPath, relationStep } from "@/lib/domain/predicate";
import { proseText } from "@/lib/domain/prose";
import {
	admittedCaseListDoc,
	findings,
	withSearchInputs,
} from "./caseListRuleFixture";

const base = () =>
	admittedCaseListDoc({
		caseTypes: [
			{
				name: "patient",
				parent_type: "household",
				properties: [
					{ name: "day", label: proseText("Day"), data_type: "date" },
				],
			},
			{
				name: "household",
				properties: [
					{ name: "day", label: proseText("Day"), data_type: "date" },
				],
			},
		],
	});
describe("search range direct-match admission", () => {
	it.each([false, true])(
		"checks both range identity constraints with explicit mode %s",
		(explicit) => {
			for (const cross of [false, true])
				for (const renamed of [false, true]) {
					const prompt = simpleSearchInputDef(
						testUuid("p"),
						renamed ? "window" : "day",
						"Day",
						"date-range",
						"day",
						{
							...(explicit ? { mode: { kind: "range" } as const } : {}),
							...(cross ? { via: ancestorPath(relationStep("parent")) } : {}),
						},
					);
					const errors = findings(withSearchInputs(base(), [prompt]));
					expect(errors.map((error) => error.code)).toEqual(
						cross || renamed
							? ["CASE_LIST_SIMPLE_INPUT_VIA_INCOMPATIBLE_MODE"]
							: [],
					);
					if (errors.length)
						expect(errors[0].details).toMatchObject({
							inputUuid: prompt.uuid,
							nameDiverges: String(renamed),
							viaKind: cross ? "ancestor" : "absent",
						});
				}
		},
	);
	it.each([
		"exact",
		"fuzzy",
		"starts-with",
		"phonetic",
		"fuzzy-date",
	] satisfies SearchInputMode["kind"][])(
		"admits %s across a real parent link",
		(kind) => {
			const prompt = simpleSearchInputDef(
				testUuid("p"),
				"parent_name",
				"Parent name",
				"text",
				"case_name",
				{ mode: { kind }, via: ancestorPath(relationStep("parent")) },
			);
			expect(findings(withSearchInputs(base(), [prompt]))).toEqual([]);
		},
	);
});
