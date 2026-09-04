import { describe, expect, it } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import { buildDoc, caseListConfig } from "@/lib/__tests__/docHelpers";
import {
	advancedSearchInputDef,
	SEARCH_INPUT_RUNTIME_VALUE_TYPES,
	simpleSearchInputDef,
} from "@/lib/domain";
import { matchAll } from "@/lib/domain/predicate";
import { proseText } from "@/lib/domain/prose";
import { moduleTypeContext } from "../shared";

describe("moduleTypeContext search-input runtime values", () => {
	it("pins every widget's runtime scalar type", () => {
		expect(SEARCH_INPUT_RUNTIME_VALUE_TYPES).toEqual({
			text: "text",
			date: "date",
			"date-range": "text",
			barcode: "text",
			select: "text",
			"multi-select": "text",
		});
	});

	it("types both authoring arms from their widget output, including encoded date ranges", () => {
		const config = caseListConfig([]);
		config.searchInputs = [
			simpleSearchInputDef(
				testUuid("00000000-0000-4000-8000-00000000b001"),
				"simple_date",
				"Simple date",
				"date",
				"seen_at",
			),
			advancedSearchInputDef(
				testUuid("00000000-0000-4000-8000-00000000b002"),
				"advanced_date",
				"Advanced date",
				"date",
				matchAll(),
			),
			simpleSearchInputDef(
				testUuid("00000000-0000-4000-8000-00000000b003"),
				"simple_range",
				"Simple range",
				"date-range",
				"visit_date",
			),
			advancedSearchInputDef(
				testUuid("00000000-0000-4000-8000-00000000b004"),
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
							label: proseText("Seen at"),
							data_type: "datetime",
						},
						{
							name: "visit_date",
							label: proseText("Visit date"),
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
				{
					uuid: config.searchInputs[0]?.uuid,
					name: "simple_date",
					data_type: "date",
				},
				{
					uuid: config.searchInputs[1]?.uuid,
					name: "advanced_date",
					data_type: "date",
				},
				{
					uuid: config.searchInputs[2]?.uuid,
					name: "simple_range",
					data_type: "text",
				},
				{
					uuid: config.searchInputs[3]?.uuid,
					name: "advanced_range",
					data_type: "text",
				},
			],
		);
	});
});
