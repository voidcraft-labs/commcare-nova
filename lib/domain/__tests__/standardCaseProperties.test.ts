import { describe, expect, it } from "vitest";
import { buildDoc } from "@/lib/__tests__/docHelpers";
import {
	authorableCaseProperties,
	canonicalCasePropertyName,
	effectiveCaseTypes,
	standardCasePropertyDisplayLabel,
} from "@/lib/domain";

describe("Nova standard case-property vocabulary", () => {
	it.each([
		["case_name", "case_name"],
		["name", "case_name"],
		["external_id", "external_id"],
		["external-id", "external_id"],
		["date_opened", "date_opened"],
		["date-opened", "date_opened"],
		["status", "status"],
		["current_status", "current_status"],
	])("canonicalizes %s to %s", (input, expected) => {
		expect(canonicalCasePropertyName(input)).toBe(expected);
	});

	it("offers one canonical choice for each CCHQ alias pair", () => {
		const properties = authorableCaseProperties([
			{ name: "case_name", label: "Case name", data_type: "text" },
			{ name: "name", label: "Name", data_type: "text" },
			{ name: "external_id", label: "External ID", data_type: "text" },
			{ name: "external-id", label: "External ID", data_type: "text" },
			{ name: "date_opened", label: "Date opened", data_type: "datetime" },
			{ name: "date-opened", label: "Date opened", data_type: "datetime" },
			{ name: "status", label: "Status", data_type: "text" },
			{ name: "current_status", label: "Workflow status", data_type: "text" },
		]);

		expect(properties.map((property) => property.name)).toEqual([
			"case_name",
			"external_id",
			"date_opened",
			"status",
			"current_status",
		]);
	});

	it("promotes an alias-only catalog entry to Nova's canonical name", () => {
		expect(
			authorableCaseProperties([
				{ name: "external-id", label: "Legacy external ID", data_type: "text" },
			]),
		).toEqual([
			{
				name: "external_id",
				label: "Legacy external ID",
				data_type: "text",
			},
		]);
	});

	it("preserves legacy authored copy while taking canonical standard semantics", () => {
		const doc = buildDoc({
			appName: "Legacy labels",
			modules: [],
			caseTypes: [
				{
					name: "patient",
					properties: [
						{
							name: "name",
							label: "Patient name",
							hint: "As shown on their card",
							data_type: "date",
						},
					],
				},
			],
		});
		const patient = effectiveCaseTypes(doc).find(
			(type) => type.name === "patient",
		);
		const property = authorableCaseProperties(patient?.properties ?? []).find(
			(candidate) => candidate.name === "case_name",
		);

		expect(property).toMatchObject({
			name: "case_name",
			label: "Patient name",
			hint: "As shown on their card",
			data_type: "text",
		});
	});

	it("explains the built-in case lifecycle status without conflating current_status", () => {
		expect(standardCasePropertyDisplayLabel("status")).toBe(
			"Case status (open or closed)",
		);
		expect(standardCasePropertyDisplayLabel("current_status")).toBe(
			"current_status",
		);
	});

	it("treats prototype-shaped user properties as ordinary property names", () => {
		expect(canonicalCasePropertyName("toString")).toBe("toString");
		expect(standardCasePropertyDisplayLabel("constructor")).toBe("constructor");
		expect(
			authorableCaseProperties([
				{ name: "toString", label: "Display text", data_type: "text" },
			]),
		).toEqual([{ name: "toString", label: "Display text", data_type: "text" }]);
	});
});
