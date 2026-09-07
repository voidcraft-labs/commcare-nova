import { describe, expect, it } from "vitest";
import { buildDoc } from "@/lib/__tests__/docHelpers";
import {
	authoredCasePropertyNameSchema,
	casePropertySchema,
	effectiveCaseTypes,
	isWritableStandardCaseProperty,
	standardCasePropertyDisplayLabel,
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

	it.each([
		["case_name", true],
		["external_id", true],
		["owner_id", false],
		["status", false],
		["current_status", false],
		["toString", false],
	] as const)(
		"classifies %s as a writable standard scalar: %s",
		(property, writable) => {
			expect(isWritableStandardCaseProperty(property)).toBe(writable);
		},
	);
});
