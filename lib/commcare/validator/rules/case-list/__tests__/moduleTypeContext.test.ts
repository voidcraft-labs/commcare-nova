import { describe, expect, it } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import { buildDoc, caseListConfig, f } from "@/lib/__tests__/docHelpers";
import { toPersistableDoc } from "@/lib/doc/fieldParent";
import { LOOKUP_CONTEXT_UNAVAILABLE } from "@/lib/doc/lookupReferences";
import {
	advancedSearchInputDef,
	blueprintDocSchema,
	simpleSearchInputDef,
} from "@/lib/domain";
import { matchAll } from "@/lib/domain/predicate";
import { proseText } from "@/lib/domain/prose";
import { runValidation } from "../../../runner";
import { moduleTypeContext } from "../shared";

describe("moduleTypeContext search-input runtime values", () => {
	it("types both authoring arms from their widget output, including encoded date ranges", () => {
		const config = caseListConfig([{ field: "case_name", header: "Name" }]);
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
				"visit_date",
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
					forms: [
						{
							name: "Register visit",
							type: "registration",
							fields: [
								f({
									kind: "text",
									id: "case_name",
									label: "Name",
									caseWrite: { caseType: "visit", property: "case_name" },
								}),
							],
						},
					],
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

		blueprintDocSchema.parse(toPersistableDoc(doc));
		expect(runValidation(doc, LOOKUP_CONTEXT_UNAVAILABLE)).toEqual([]);
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
					name: "visit_date",
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
