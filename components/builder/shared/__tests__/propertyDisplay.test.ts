import { describe, expect, it } from "vitest";
import { type ProseTemplate, proseText } from "@/lib/domain/prose";
import {
	friendlyPropertyDisambiguator,
	propertyDisplayLabel,
	propertyDisplayLabelForName,
	propertyFallbackDisplayLabel,
} from "../primitives/propertyDisplay";

/** These fixtures carry plain text labels, so concatenating the text runs is
 *  the exact projection a document would produce. */
const stubProject = (label: ProseTemplate): string =>
	label.parts.map((part) => (part.kind === "text" ? part.text : "")).join("");

describe("propertyDisplayLabel", () => {
	it("uses friendly system labels instead of stored identifiers", () => {
		expect(
			propertyDisplayLabel(
				{
					name: "external_id",
					label: proseText("external_id"),
				},
				stubProject,
			),
		).toBe("External ID");
		expect(
			propertyDisplayLabel(
				{ name: "status", label: proseText("Status") },
				stubProject,
			),
		).toBe("Case status (open or closed)");
	});

	it("keeps a meaningful authored label", () => {
		expect(
			propertyDisplayLabel(
				{
					name: "case_name",
					label: proseText("Patient name"),
				},
				stubProject,
			),
		).toBe("Patient name");
		expect(
			propertyDisplayLabel(
				{
					name: "current_status",
					label: proseText("Workflow stage"),
				},
				stubProject,
			),
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
			propertyDisplayLabelForName(
				"external_id",
				[
					{
						name: "external_id",
						label: proseText("external_id"),
						data_type: "text",
					},
				],
				stubProject,
			),
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
		expect(
			friendlyPropertyDisambiguator(properties[0], properties, stubProject),
		).toBe(undefined);
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
		expect(
			friendlyPropertyDisambiguator(properties[0], properties, stubProject),
		).toBe("Home region");
		expect(
			friendlyPropertyDisambiguator(properties[1], properties, stubProject),
		).toBe("Work region");
	});
});
