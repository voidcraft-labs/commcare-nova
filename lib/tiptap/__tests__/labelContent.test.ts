// @vitest-environment happy-dom

import { Editor } from "@tiptap/core";
import { expect, it } from "vitest";
import type { ProseTemplate } from "@/lib/domain";
import { encodeProseReferencePart } from "../commcareRefNode";
import {
	createInlineEditorExtensions,
	createMarkdownEditorExtensions,
	getMarkdownContent,
	markdownToProseTemplate,
	proseTemplateToMarkdown,
} from "../markdownExtensions";

const picture = "/worker-guide/photo.png";
const raw = `<img src="${picture}" alt="Written tag">`;
const embedded = "data:image/png;base64,AA==";

it.each([
	["subtitle", createMarkdownEditorExtensions],
	["label", () => createInlineEditorExtensions(null, () => undefined)],
] as const)(
	"keeps %s pictures and literal HTML through editing without an external image element",
	(_name, extensions) => {
		const markdown = `![External picture](${picture} "Guide") and ![Embedded picture](${embedded}) alongside ${raw} and [Call](tel:123)`;
		const editor = new Editor({ extensions: extensions(), content: markdown });
		try {
			expect(editor.view.dom.textContent).toContain("External picture");
			expect(editor.view.dom.textContent).toContain(raw);
			expect(
				[...editor.view.dom.querySelectorAll("img[src]")].map((img) =>
					img.getAttribute("src"),
				),
			).toEqual([embedded]);
			expect(editor.view.dom.querySelector("a[href]")).toBeNull();
			expect(editor.view.dom.textContent).toContain("Call");
			expect(getMarkdownContent(editor)).toBe(markdown);
		} finally {
			editor.destroy();
		}
	},
);

it("keeps the worker's native image in a table that cannot be written as pipe Markdown", () => {
	const html = `<table><tbody><tr><td colspan="2"><p><img src="${picture}" alt="District"></p></td></tr></tbody></table>`;
	const editor = new Editor({
		extensions: createMarkdownEditorExtensions(),
		content: html,
	});
	try {
		expect(editor.view.dom.querySelector("table img[src]")).toBeNull();
		expect(editor.view.dom.querySelector("table")?.textContent).toBe(
			"District",
		);
		const saved = getMarkdownContent(editor);
		expect(saved).toContain(`<img src="${picture}" alt="District">`);
		editor.commands.setContent(saved);
		expect(editor.view.dom.querySelector("table img[src]")).toBeNull();
		expect(getMarkdownContent(editor)).toBe(saved);
	} finally {
		editor.destroy();
	}
});

it.each(["paragraph", "table"])(
	"preserves a typed reference and identical literal app markup in a %s",
	(where) => {
		const ref = {
			kind: "case-ref",
			caseType: "client",
			property: "case_name",
		} as const;
		const literal = `<span data-nova-prose-ref="${encodeProseReferencePart(ref)}"></span>`;
		const before =
			where === "table" ? '<table><tbody><tr><td colspan="2"><p>' : "";
		const after = before ? "</p></td></tr></tbody></table>" : "";
		const template: ProseTemplate = {
			parts: [
				{ kind: "text", text: `${before}Literal ${literal}, typed ` },
				ref,
				{ kind: "text", text: ` after${after}` },
			],
		};
		const editor = new Editor({
			extensions: createInlineEditorExtensions(null, () => undefined),
			content: proseTemplateToMarkdown(template),
		});
		try {
			const stored = markdownToProseTemplate(getMarkdownContent(editor));
			expect(stored.parts).toHaveLength(3);
			expect(stored.parts[1]).toEqual(ref);
			expect(stored.parts[0]).toMatchObject({
				kind: "text",
				text: expect.stringContaining(`Literal ${literal}, typed `),
			});
			editor.commands.setContent(proseTemplateToMarkdown(stored));
			expect(markdownToProseTemplate(getMarkdownContent(editor))).toEqual(
				stored,
			);
		} finally {
			editor.destroy();
		}
	},
);
