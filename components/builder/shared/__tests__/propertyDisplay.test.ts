import { describe, expect, it } from "vitest";
import {
	propertyDisplayLabel,
	propertyDisplayLabelForName,
	propertyFallbackDisplayLabel,
} from "../primitives/propertyDisplay";

describe("propertyDisplayLabel", () => {
	it("uses friendly system labels instead of stored identifiers", () => {
		expect(
			propertyDisplayLabel({ name: "external_id", label: "external_id" }),
		).toBe("External ID");
		expect(propertyDisplayLabel({ name: "status", label: "Status" })).toBe(
			"Case status (open or closed)",
		);
	});

	it("keeps a meaningful authored label", () => {
		expect(
			propertyDisplayLabel({ name: "case_name", label: "Patient name" }),
		).toBe("Patient name");
		expect(
			propertyDisplayLabel({ name: "current_status", label: "Workflow stage" }),
		).toBe("Workflow stage");
	});

	it.each([
		["name", "Case name"],
		["external-id", "External ID"],
		["date-opened", "Date opened"],
	])("canonicalizes the legacy %s fallback", (name, label) => {
		expect(propertyFallbackDisplayLabel(name)).toBe(label);
	});

	it("collapses a generated alias label when its canonical definition is present", () => {
		expect(
			propertyDisplayLabelForName("external-id", [
				{
					name: "external-id",
					label: "external-id",
					data_type: "text",
				},
				{ name: "external_id", label: "external_id", data_type: "text" },
			]),
		).toBe("External ID");
	});

	it("preserves meaningful copy authored on a legacy alias", () => {
		expect(
			propertyDisplayLabelForName("external-id", [
				{
					name: "external-id",
					label: "Partner registry number",
					data_type: "text",
				},
				{ name: "external_id", label: "external_id", data_type: "text" },
			]),
		).toBe("Partner registry number");
	});
});
