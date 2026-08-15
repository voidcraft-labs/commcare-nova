import { describe, expect, it } from "vitest";
import { buildDoc, f, xp } from "@/lib/__tests__/docHelpers";
import { hydratePersistedBlueprint } from "@/lib/doc/fieldParent";
import type { Field } from "@/lib/domain";
import { proseText } from "@/lib/domain/prose";
import {
	planXPathCarrierCompatibilityRepair,
	XPATH_CARRIER_COMPATIBILITY_REPAIR_TARGETS,
} from "../xpathCarrierCompatibilityRepair";

const TARGET = XPATH_CARRIER_COMPATIBILITY_REPAIR_TARGETS[0];

function fixture(defaultValue = "here()") {
	return buildDoc({
		appId: TARGET.appId,
		modules: [
			{
				name: "Locations",
				forms: [
					{
						name: "Visit",
						type: "survey",
						fields: [
							f({
								uuid: TARGET.fieldUuid,
								kind: "geopoint",
								id: "visit_location",
								default_value: defaultValue,
								relevant: "true()",
							}),
						],
					},
				],
			},
		],
	});
}

describe("XPath carrier compatibility repair", () => {
	it("clears only the reviewed here() default and is idempotent", () => {
		const source = fixture();
		const first = planXPathCarrierCompatibilityRepair(source);
		expect(first.findings).toMatchObject([
			{ standing: "repairable", fieldUuid: TARGET.fieldUuid },
		]);
		const repaired = first.targetDoc.fields[TARGET.fieldUuid];
		expect(repaired).not.toHaveProperty("default_value");
		expect(repaired).toHaveProperty("relevant");
		expect(source.fields[TARGET.fieldUuid]).toHaveProperty("default_value");

		expect(
			planXPathCarrierCompatibilityRepair(
				hydratePersistedBlueprint(first.targetDoc),
			).findings,
		).toMatchObject([{ standing: "clean" }]);
	});

	it("does not overwrite a later safe user edit", () => {
		expect(
			planXPathCarrierCompatibilityRepair(fixture("today()")).findings,
		).toMatchObject([{ standing: "superseded" }]);
	});

	it("blocks when here() remains in an unreviewed expression shape", () => {
		expect(
			planXPathCarrierCompatibilityRepair(fixture("if(true(), here(), '')"))
				.findings,
		).toMatchObject([{ standing: "blocked" }]);
	});

	it("blocks if the reviewed identity changed kind while retaining here()", () => {
		const source = fixture();
		source.fields[TARGET.fieldUuid] = {
			...source.fields[TARGET.fieldUuid],
			kind: "text",
			label: proseText("Location"),
			default_value: xp("here()"),
		} as Field;
		expect(planXPathCarrierCompatibilityRepair(source).findings).toMatchObject([
			{ standing: "blocked" },
		]);
	});
});
