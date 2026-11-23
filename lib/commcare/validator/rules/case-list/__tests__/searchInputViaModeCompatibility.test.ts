import { describe, expect, it } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import { simpleArmNeedsXPathQueryEmission } from "@/lib/commcare/suite/case-search/simpleArmDerivation";
import {
	type SearchInputMode,
	type SimpleSearchInputDef,
	searchForBlankRefusal,
	searchInputDefSchema,
	simpleSearchInputDef,
} from "@/lib/domain";
import { ancestorPath, relationStep } from "@/lib/domain/expression";
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

// Searching for blank rides the bare prompt: the gate refuses a simple field
// with it exactly where the field is matched through `_xpath_query`, where the
// blank reads as part of the answer.
describe("search for blank admission", () => {
	it("refuses a search for blank exactly where the field leaves the bare prompt", () => {
		const types = ["text", "date", "date-range"] as const;
		const modes: (SearchInputMode | undefined)[] = [
			undefined,
			{ kind: "exact" },
			{ kind: "fuzzy" },
		];
		let refused = 0;
		let admitted = 0;
		for (const type of types)
			for (const mode of type === "date-range" ? [undefined] : modes)
				for (const projectSpace of [false, true])
					for (const cross of [false, true])
						for (const renamed of [false, true]) {
							const prompt = searchInputDefSchema.parse({
								uuid: testUuid("p"),
								kind: "simple",
								name: renamed ? "window" : "day",
								label: "Day",
								type,
								property: "day",
								allowBlank: true,
								...(type === "date-range"
									? { mode: { kind: "range" } }
									: mode !== undefined && { mode }),
								...(projectSpace && { matching: "project-space" }),
								...(cross && { via: ancestorPath(relationStep("parent")) }),
							}) as SimpleSearchInputDef;
							const blank = findings(withSearchInputs(base(), [prompt])).filter(
								(error) =>
									error.code ===
									"CASE_LIST_SEARCH_FOR_BLANK_NEEDS_OWN_PROPERTY",
							);
							const reason = searchForBlankRefusal(prompt);
							expect(blank.length, JSON.stringify(prompt)).toBe(
								reason === undefined ? 0 : 1,
							);
							if (reason === undefined) {
								admitted += 1;
								expect(simpleArmNeedsXPathQueryEmission(prompt)).toBe(false);
							} else {
								refused += 1;
								expect(blank[0]?.details).toMatchObject({
									inputUuid: prompt.uuid,
									reason,
								});
							}
						}
		expect(admitted).toBeGreaterThan(0);
		expect(refused).toBeGreaterThan(0);
	});

	it("refuses a search for blank on case information stored as an attribute", () => {
		const prompt = simpleSearchInputDef(
			testUuid("p"),
			"status",
			"Status",
			"text",
			"status",
			{ allowBlank: true, matching: "project-space" },
		);
		expect(searchForBlankRefusal(prompt)).toBeDefined();
	});
});
