/**
 * TipTap extension configuration for WYSIWYG markdown editing.
 *
 * Used by InlineTextEditor (text cursor mode) to enable full markdown
 * rendering with round-trip serialization via tiptap-markdown. Supports
 * the CommCare Web Apps markdown feature set: headings, bold, italic,
 * links, images, lists, code (inline + block), horizontal rules, and
 * GFM tables. Blockquote and strikethrough are intentionally disabled —
 * CommCare Web Apps has no visible styling for blockquotes and doesn't
 * load the markdown-it strikethrough plugin. CommcareRef nodes serialize as
 * bare `#type/path` hashtags and parse back via `hydrateHashtagRefs()`.
 *
 * Contrast with RefLabelInput which uses StarterKit with everything
 * disabled except paragraphs — that editor is text-only with chips.
 * This editor is a full WYSIWYG surface.
 */

import type { Extensions } from "@tiptap/core";
import { Image } from "@tiptap/extension-image";
import Mention from "@tiptap/extension-mention";
import {
	Table,
	TableCell,
	TableHeader,
	TableRow,
} from "@tiptap/extension-table";
import StarterKit from "@tiptap/starter-kit";
import { Markdown } from "tiptap-markdown";
import type { ReferenceProvider } from "@/lib/references/provider";
import { CommcareRef } from "./commcareRefNode";
import { createRefSuggestion } from "./refSuggestion";

/**
 * Create the full WYSIWYG extension set for inline text editing.
 *
 * StarterKit provides the core formatting: headings (1-3), bold, italic,
 * code, lists, horizontal rule, and links. Additional
 * extensions add image and GFM table support — the full CommCare markdown
 * feature set. The Markdown extension handles bidirectional conversion.
 * CommcareRef provides bare hashtag round-tripping. Mention wires
 * the `#` trigger to ReferenceProvider for chip autocomplete.
 *
 * @param provider - ReferenceProvider for hashtag autocomplete (null disables autocomplete)
 */
export function createInlineEditorExtensions(
	provider: ReferenceProvider | null,
): Extensions {
	const suggestion = provider ? createRefSuggestion(provider) : undefined;

	return [
		StarterKit.configure({
			/* Headings limited to 1-3 — deeper levels aren't useful in form labels. */
			heading: { levels: [1, 2, 3] },
			/* Links open in new tab (CommCare default) and don't activate on click
			 * inside the editor — users need to click to position their cursor. */
			link: {
				openOnClick: false,
				HTMLAttributes: { target: "_blank", rel: "noopener noreferrer" },
			},
			/* Blockquote and strikethrough are disabled because CommCare Web Apps
			 * has no visible styling for either — blockquotes render identically to
			 * paragraphs (Bootstrap reboot margin only), and markdown-it's
			 * strikethrough plugin is not loaded. Exposing them here would give
			 * users a false impression of how their content will render. */
			blockquote: false,
			strike: false,
		}),
		/* Inline images — `![alt](url)` in markdown. */
		Image.configure({ inline: true }),
		/* GFM pipe tables — `| col | col |` syntax. Requires all four table
		 * node types (table, row, header cell, body cell) for ProseMirror. */
		Table.configure({ resizable: false }),
		TableRow,
		TableHeader,
		TableCell,
		Markdown.configure({
			html: true,
			breaks: true,
			transformPastedText: true,
			transformCopiedText: true,
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

/**
 * Extract markdown content from a TipTap editor using tiptap-markdown's
 * serializer. Falls back to empty string if the storage isn't available.
 *
 * Accepts `Editor` from `@tiptap/core`. The `storage` field is typed as
 * `Record<string, any>` by TipTap, so the `markdown.getMarkdown()` access
 * is dynamically typed — tiptap-markdown adds it at runtime.
 */
export function getMarkdownContent(editor: {
	// biome-ignore lint/suspicious/noExplicitAny: TipTap's storage is typed as Record<string, any>
	storage: Record<string, any>;
}): string {
	return editor.storage.markdown?.getMarkdown?.() ?? "";
}
