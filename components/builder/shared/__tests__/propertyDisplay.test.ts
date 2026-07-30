import { describe, expect, it } from "vitest";
import { proseText } from "@/lib/domain/prose";
import {
	friendlyPropertyDisambiguator,
	propertyDisplayLabel,
	propertyDisplayLabelForName,
	propertyFallbackDisplayLabel,
} from "../primitives/propertyDisplay";

describe("propertyDisplayLabel", () => {
	it("uses friendly system labels instead of stored identifiers", () => {
		expect(
			propertyDisplayLabel({
				name: "external_id",
				label: proseText("external_id"),
			}),
		).toBe("External ID");
		expect(
			propertyDisplayLabel({ name: "status", label: proseText("Status") }),
		).toBe("Case status (open or closed)");
	});

	it("keeps a meaningful authored label", () => {
		expect(
			propertyDisplayLabel({
				name: "case_name",
				label: proseText("Patient name"),
			}),
		).toBe("Patient name");
		expect(
			propertyDisplayLabel({
				name: "current_status",
				label: proseText("Workflow stage"),
			}),
		).toBe("Workflow stage");
	});

	it.each([
		["case_name", "Case name"],
		["external_id", "External ID"],
		["date_opened", "Date opened"],
	])("uses the friendly fallback for standard %s", (name, label) => {
		expect(propertyFallbackDisplayLabel(name)).toBe(label);
	});

	it("resolves an exact property definition by name", () => {
		expect(
			propertyDisplayLabelForName("external_id", [
				{
					name: "external_id",
					label: proseText("external_id"),
					data_type: "text",
				},
			]),
		).toBe("External ID");
	});

	it("never repeats the visible label as its own disambiguator", () => {
		const properties = [
			{
				name: "case_name",
				label: proseText("case_name"),
				data_type: "text" as const,
			},
			{
				name: "display_name",
				label: proseText("case_name"),
				data_type: "text" as const,
			},
		];
		expect(friendlyPropertyDisambiguator(properties[0], properties)).toBe(
			undefined,
		);
	});

	it("keeps a parenthetical when it genuinely distinguishes equal labels", () => {
		const properties = [
			{
				name: "home_region",
				label: proseText("Region"),
				data_type: "text" as const,
			},
			{
				name: "work_region",
				label: proseText("Region"),
				data_type: "text" as const,
			},
		];
		expect(friendlyPropertyDisambiguator(properties[0], properties)).toBe(
			"Home region",
		);
		expect(friendlyPropertyDisambiguator(properties[1], properties)).toBe(
			"Work region",
		);
	});
});
