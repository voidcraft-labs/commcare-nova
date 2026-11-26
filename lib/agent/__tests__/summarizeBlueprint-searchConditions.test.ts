import { describe, expect, it } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import {
	type BlueprintDoc,
	type CaseListConfig,
	simpleSearchInputDef,
} from "@/lib/domain";
import { eq, literal, prop, term } from "@/lib/domain/expression";
import { summarizeBlueprint } from "../summarizeBlueprint";
import {
	MOD_A,
	makeCaseListDoc,
} from "../tools/case-list-config/__tests__/fixtures";
import { expectAdmittedDoc } from "./admittedFixture";

const FILTER = testUuid("summary-search-filter");

function summaryWith(
	patch: Partial<CaseListConfig>,
	searchOn: boolean,
): string[] {
	const doc = makeCaseListDoc();
	const mod = doc.modules[MOD_A];
	const config = mod.caseListConfig;
	if (config === undefined) throw new Error("fixture config missing");
	const next: BlueprintDoc = {
		...doc,
		modules: {
			[MOD_A]: {
				...mod,
				...(searchOn && { caseSearchConfig: {} }),
				caseListConfig: { ...config, ...patch },
			},
		},
	};
	return summarizeBlueprint(expectAdmittedDoc(next)).split("\n");
}

const conditionLines = (lines: readonly string[]) =>
	lines.filter((line) =>
		/^\s+(filter|list_filter|search_condition|search_filters|- .*: (property|the record))/.test(
			line,
		),
	);

describe("summarizeBlueprint's case list conditions", () => {
	const active = eq(prop("patient", "region"), literal("north"));

	it("prints one condition as before when the search keeps the list's", () => {
		expect(conditionLines(summaryWith({ filter: active }, true))).toEqual([
			"      filter: (predicate kind: eq)",
		]);
	});

	it("names each surface's condition and every search filter by its uuid", () => {
		const lines = summaryWith(
			{
				filter: active,
				searchCondition: { kind: "match-all" },
				searchFilters: [
					{
						uuid: FILTER,
						target: { kind: "property", property: "region" },
						value: term(literal("north")),
					},
				],
			},
			true,
		);
		expect(conditionLines(lines)).toEqual([
			"      list_filter (device list only): (predicate kind: eq)",
			"      search_condition (online search only): all records",
			"      search_filters:",
			`        - ${FILTER}: property region`,
		]);
	});
});

// update_search_input replaces a field's whole body, so the summary marks the
// search for blank as it marks the field's other prompt slots.
it("marks a Search field that also finds blank", () => {
	const lines = summaryWith(
		{
			searchInputs: [
				simpleSearchInputDef(
					testUuid("summary-blank-region"),
					"region",
					"Region",
					"text",
					"region",
					{ allowBlank: true },
				),
			],
		},
		true,
	);
	expect(
		lines.some(
			(line) => line.includes("region") && line.endsWith("[finds blank]"),
		),
	).toBe(true);
});
