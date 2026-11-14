import { describe, expect, it } from "vitest";
import type { ProseTemplate } from "@/lib/domain";
import {
	markdownToProseTemplate,
	proseTemplateToMarkdown,
} from "../markdownExtensions";
import {
	proseTemplateSurvivesTiptapRoundTrip,
	proseTemplateToTiptapContent,
	tiptapContentToProseTemplate,
} from "../proseTemplateCodec";

describe("proseTemplateSurvivesTiptapRoundTrip", () => {
	it("compares semantic JSON structure instead of case-ref key order", () => {
		const admissionOrdered: ProseTemplate = {
			parts: [
				{ kind: "text", text: "Client: " },
				{
					caseType: "client",
					kind: "case-ref",
					property: "case_name",
				},
			],
		};

		expect(proseTemplateSurvivesTiptapRoundTrip(admissionOrdered)).toBe(true);
	});

	it("rejects adjacent text parts that the editor canonicalizes", () => {
		// Persisted/runtime input can bypass the static type. The editor merges
		// adjacent text nodes into one canonical part, so this input does change.
		const adjacentText: ProseTemplate = {
			parts: [
				{ kind: "text", text: "Client" },
				{ kind: "text", text: " summary" },
			],
		};

		expect(proseTemplateSurvivesTiptapRoundTrip(adjacentText)).toBe(false);
	});

	it("keeps a calculated value whole through the editor's document and its Markdown carrier", () => {
		const withValue: ProseTemplate = {
			parts: [
				{ kind: "text", text: "Due **soon**: " },
				{
					kind: "value",
					expression: {
						kind: "concat",
						parts: [
							{ kind: "term", term: { kind: "literal", value: "a_b*c" } },
							{
								kind: "term",
								term: { kind: "literal", value: "'quoted' & <x>" },
							},
						],
					},
				},
				{ kind: "text", text: " today" },
			],
		};
		expect(proseTemplateSurvivesTiptapRoundTrip(withValue)).toBe(true);
		expect(
			tiptapContentToProseTemplate(proseTemplateToTiptapContent(withValue)),
		).toEqual(withValue);
		expect(markdownToProseTemplate(proseTemplateToMarkdown(withValue))).toEqual(
			withValue,
		);
	});
});
