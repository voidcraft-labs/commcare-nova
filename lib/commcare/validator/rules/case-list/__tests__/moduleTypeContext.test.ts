import { describe, expect, it } from "vitest";
import { buildDoc, caseListConfig } from "@/lib/__tests__/docHelpers";
import {
	advancedSearchInputDef,
	asUuid,
	SEARCH_INPUT_RUNTIME_VALUE_TYPES,
	simpleSearchInputDef,
} from "@/lib/domain";
import { matchAll } from "@/lib/domain/predicate";
import { moduleTypeContext } from "../shared";

describe("moduleTypeContext search-input runtime values", () => {
	it("pins every widget's runtime scalar type", () => {
		expect(SEARCH_INPUT_RUNTIME_VALUE_TYPES).toEqual({
			text: "text",
			select: "text",
			date: "date",
			"date-range": "text",
			barcode: "text",
		});
	});

	it("types both authoring arms from their widget output, including encoded date ranges", () => {
		const config = caseListConfig([]);
		config.searchInputs = [
			simpleSearchInputDef(
				asUuid("00000000-0000-4000-8000-00000000b001"),
				"simple_date",
				"Simple date",
				"date",
				"seen_at",
			),
			advancedSearchInputDef(
				asUuid("00000000-0000-4000-8000-00000000b002"),
				"advanced_date",
				"Advanced date",
				"date",
				matchAll(),
			),
			simpleSearchInputDef(
				asUuid("00000000-0000-4000-8000-00000000b003"),
				"simple_range",
				"Simple range",
				"date-range",
				"visit_date",
			),
			advancedSearchInputDef(
				asUuid("00000000-0000-4000-8000-00000000b004"),
				"advanced_range",
				"Advanced range",
				"date-range",
				matchAll(),
			),
		];
		const doc = buildDoc({
			appName: "Runtime input types",
			modules: [
				{
					name: "Visits",
					caseType: "visit",
					caseListConfig: config,
					forms: [],
				},
			],
			caseTypes: [
				{
					name: "visit",
					properties: [
						{
							name: "seen_at",
							label: "Seen at",
							data_type: "datetime",
						},
						{
							name: "visit_date",
							label: "Visit date",
							data_type: "date",
						},
					],
				},
			],
		});

		const moduleUuid = doc.moduleOrder[0];
		if (moduleUuid === undefined) throw new Error("missing module fixture");
		expect(moduleTypeContext(doc.modules[moduleUuid], doc).knownInputs).toEqual(
			[
				{ name: "simple_date", data_type: "date" },
				{ name: "advanced_date", data_type: "date" },
				{ name: "simple_range", data_type: "text" },
				{ name: "advanced_range", data_type: "text" },
			],
		);
	});
});
