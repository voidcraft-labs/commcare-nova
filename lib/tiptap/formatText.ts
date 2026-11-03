/**
 * Format text: the Tiptap side of a label's or a choice's `plainLabel`.
 *
 * A text with Format text on is read as Markdown: the inline editor parses its
 * stored characters into marks and block nodes and serializes them back. A
 * text with Format text off is shown exactly as stored, so its editor holds
 * the same characters as plain paragraphs (one per line) plus reference chips,
 * with no Markdown parsing or serializing in either direction.
 *
 * Whether a text "holds formatting" is read from the Tiptap document the
 * Markdown reading produces: any mark, or any node other than the ones a
 * plain text is made of, means turning Format text off changes what a worker
 * sees.
 */

import { Editor, type Extensions, type JSONContent } from "@tiptap/core";
import Mention from "@tiptap/extension-mention";
import StarterKit from "@tiptap/starter-kit";
import { canonicalProseTemplate, type ProseTemplate } from "@/lib/domain";
import type { ReferenceProvider } from "@/lib/references/provider";
import { CommcareRef } from "./commcareRefNode";
import {
	createMarkdownEditorExtensions,
	proseTemplateToMarkdown,
} from "./markdownExtensions";
import {
	proseTemplateToTiptapContent,
	tiptapContentToProseTemplate,
} from "./proseTemplateCodec";
import { createRefSuggestion } from "./refSuggestion";

/** The nodes a text with no formatting is made of: lines, characters,
 *  reference chips, and the line break Markdown reads a single newline as. */
const PLAIN_NODE_TYPES: ReadonlySet<string> = new Set([
	"doc",
	"paragraph",
	"text",
	"hardBreak",
	"commcareRef",
	"mention",
]);

/** Whether a Tiptap document holds any mark or any node beyond plain lines,
 *  characters and reference chips. */
export function tiptapDocHoldsFormatting(node: JSONContent): boolean {
	if (node.marks !== undefined && node.marks.length > 0) return true;
	if (node.type !== undefined && !PLAIN_NODE_TYPES.has(node.type)) return true;
	return (node.content ?? []).some(tiptapDocHoldsFormatting);
}

/**
 * Whether a stored text, read as Markdown, holds formatting. Parses the text
 * through the same extension set the label editor reads it with, in an editor
 * that is never mounted, and walks the document that reading produces.
 */
export function proseTemplateHoldsFormatting(template: ProseTemplate): boolean {
	const editor = new Editor({
		extensions: [...createMarkdownEditorExtensions(), CommcareRef],
		content: proseTemplateToMarkdown(template),
	});
	try {
		return tiptapDocHoldsFormatting(editor.getJSON());
	} finally {
		editor.destroy();
	}
}

/**
 * The extension set for a label with Format text off: paragraphs, text and
 * reference chips, plus the `#` reference trigger. Every mark and every block
 * node is left out of the schema, so a shortcut or a paste cannot add
 * formatting the stored text would not show.
 */
export function createPlainLabelEditorExtensions(
	provider: ReferenceProvider | null,
	getFormUuid: () => string | undefined,
): Extensions {
	const suggestion = provider
		? createRefSuggestion(provider, getFormUuid)
		: undefined;
	return [
		StarterKit.configure({
			blockquote: false,
			bold: false,
			bulletList: false,
			code: false,
			codeBlock: false,
			hardBreak: false,
			heading: false,
			horizontalRule: false,
			italic: false,
			link: false,
			listItem: false,
			listKeymap: false,
			orderedList: false,
			strike: false,
			underline: false,
		}),
		CommcareRef,
		...(suggestion
			? [
					Mention.configure({
						HTMLAttributes: { class: "commcare-ref-mention" },
						suggestion,
						renderLabel: () => "",
					}),
				]
			: []),
	];
}

/** A stored text as the plain editor's content: its characters, one
 *  paragraph per line, with its references as chips. */
export function plainLabelEditorContent(template: ProseTemplate): JSONContent {
	return proseTemplateToTiptapContent(template) as JSONContent;
}

/** The plain editor's document as the text it stores, trimmed the way the
 *  Markdown editor's save trims. */
export function plainLabelEditorTemplate(doc: JSONContent): ProseTemplate {
	return canonicalProseTemplate(tiptapContentToProseTemplate(doc).parts, {
		trim: true,
	});
}
