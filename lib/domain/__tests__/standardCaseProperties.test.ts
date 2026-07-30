import { describe, expect, it } from "vitest";
import { buildDoc } from "@/lib/__tests__/docHelpers";
import {
	authoredCasePropertyNameSchema,
	casePropertySchema,
	effectiveCaseTypes,
	FORBIDDEN_CASE_OPERATION_WRITE_PROPERTIES,
	FORBIDDEN_CASE_WRITE_PROPERTIES,
	isWritableStandardCaseProperty,
	standardCasePropertyDisplayLabel,
	WRITABLE_STANDARD_CASE_PROPERTIES,
} from "@/lib/domain";
import { proseText } from "@/lib/domain/prose";

describe("Nova standard case-property vocabulary", () => {
	it.each([
		"case_name",
		"external_id",
		"date_opened",
		"status",
		"current_status",
		"client-code",
		"toString",
	])("accepts the authored property name %s exactly", (name) => {
		expect(authoredCasePropertyNameSchema.parse(name)).toBe(name);
	});

	it.each(["name", "external-id", "date-opened"])(
		"rejects the retired CCHQ spelling %s instead of normalizing it",
		(name) => {
			expect(authoredCasePropertyNameSchema.safeParse(name).success).toBe(
				false,
			);
			expect(
				casePropertySchema.safeParse({
					name,
					label: proseText("Value"),
					data_type: "text",
				}).success,
			).toBe(false);
		},
	);

	it("materializes only Nova's exact standard names", () => {
		const doc = buildDoc({
			appName: "Standard properties",
			modules: [],
			caseTypes: [{ name: "patient", properties: [] }],
		});
		const patient = effectiveCaseTypes(doc).find(
			(type) => type.name === "patient",
		);
		const names = patient?.properties.map((property) => property.name) ?? [];

		expect(names).toContain("case_name");
		expect(names).toContain("external_id");
		expect(names).toContain("date_opened");
		expect(names).not.toContain("name");
		expect(names).not.toContain("external-id");
		expect(names).not.toContain("date-opened");
	});

	it("explains the built-in case lifecycle status without conflating current_status", () => {
		expect(standardCasePropertyDisplayLabel("status")).toBe(
			"Case status (open or closed)",
		);
		expect(standardCasePropertyDisplayLabel("current_status")).toBe(
			"current_status",
		);
	});

	it("treats prototype-shaped property names as ordinary exact names", () => {
		expect(authoredCasePropertyNameSchema.parse("toString")).toBe("toString");
		expect(standardCasePropertyDisplayLabel("constructor")).toBe("constructor");
	});

	it("defines one exact standard-scalar write contract for fields and operations", () => {
		expect([...WRITABLE_STANDARD_CASE_PROPERTIES].sort()).toEqual([
			"case_name",
			"external_id",
		]);
		expect(isWritableStandardCaseProperty("case_name")).toBe(true);
		expect(isWritableStandardCaseProperty("external_id")).toBe(true);
		expect(isWritableStandardCaseProperty("owner_id")).toBe(false);

		for (const property of WRITABLE_STANDARD_CASE_PROPERTIES) {
			expect(FORBIDDEN_CASE_WRITE_PROPERTIES.has(property)).toBe(false);
		}
		expect(FORBIDDEN_CASE_OPERATION_WRITE_PROPERTIES.has("case_name")).toBe(
			true,
		);
		expect(FORBIDDEN_CASE_OPERATION_WRITE_PROPERTIES.has("external_id")).toBe(
			false,
		);
	});
});
