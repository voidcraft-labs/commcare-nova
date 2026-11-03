// @vitest-environment happy-dom

import { describe, expect, it } from "vitest";
import { type ProseTemplate, proseText } from "@/lib/domain";
import {
	plainLabelEditorContent,
	plainLabelEditorTemplate,
	proseTemplateHoldsFormatting,
	tiptapDocHoldsFormatting,
} from "../formatText";

const withReference: ProseTemplate = {
	parts: [
		{ kind: "text", text: "Hello **" },
		{ kind: "case-ref", caseType: "client", property: "case_name" },
		{ kind: "text", text: "**\nsecond line" },
	],
};

describe("whether a text holds formatting, read from its Markdown document", () => {
	it("finds marks and block nodes the Markdown reading produces", () => {
		expect(proseTemplateHoldsFormatting(proseText("**bold** words"))).toBe(
			true,
		);
		expect(proseTemplateHoldsFormatting(proseText("_tilted_"))).toBe(true);
		expect(proseTemplateHoldsFormatting(proseText("# Heading"))).toBe(true);
		expect(proseTemplateHoldsFormatting(proseText("- one\n- two"))).toBe(true);
		expect(proseTemplateHoldsFormatting(proseText("[site](https://a.b)"))).toBe(
			true,
		);
		expect(proseTemplateHoldsFormatting(proseText("use `code`"))).toBe(true);
	});

	it("reads plain lines, line breaks and reference chips as no formatting", () => {
		expect(proseTemplateHoldsFormatting(proseText("How old are you?"))).toBe(
			false,
		);
		expect(proseTemplateHoldsFormatting(proseText("first\nsecond"))).toBe(
			false,
		);
		expect(
			proseTemplateHoldsFormatting({
				parts: [
					{ kind: "text", text: "Visit for " },
					{ kind: "case-ref", caseType: "client", property: "case_name" },
				],
			}),
		).toBe(false);
	});

	it("walks every depth of a document for a mark", () => {
		expect(
			tiptapDocHoldsFormatting({
				type: "doc",
				content: [
					{
						type: "paragraph",
						content: [
							{ type: "text", text: "a " },
							{ type: "text", text: "b", marks: [{ type: "italic" }] },
						],
					},
				],
			}),
		).toBe(true);
		expect(
			tiptapDocHoldsFormatting({
				type: "doc",
				content: [
					{ type: "paragraph", content: [{ type: "text", text: "a" }] },
				],
			}),
		).toBe(false);
	});
});

describe("the plain editor holds the stored characters", () => {
	it("round-trips Markdown symbols, lines and references unread", () => {
		expect(
			plainLabelEditorTemplate(plainLabelEditorContent(withReference)),
		).toEqual(withReference);
		expect(
			plainLabelEditorTemplate(plainLabelEditorContent(proseText("**bold**"))),
		).toEqual(proseText("**bold**"));
	});

	it("trims the edges the way the Markdown editor's save does", () => {
		expect(
			plainLabelEditorTemplate({
				type: "doc",
				content: [
					{ type: "paragraph", content: [{ type: "text", text: "  Age  " }] },
					{ type: "paragraph" },
				],
			}),
		).toEqual(proseText("Age"));
	});
});
