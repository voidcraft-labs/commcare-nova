/**
 * TipTap extension configuration for WYSIWYG markdown editing.
 *
 * Two tiers, both with round-trip serialization via tiptap-markdown and
 * both scoped to the CommCare Web Apps markdown feature set: headings,
 * bold, italic, links, images, lists, code (inline + block), horizontal
 * rules, and GFM tables. Blockquote and strikethrough are intentionally
 * disabled — CommCare Web Apps has no visible styling for blockquotes
 * and doesn't load the markdown-it strikethrough plugin.
 *
 * - `createMarkdownEditorExtensions` — the base set, for markdown slots
 *   that are plain localized strings on the wire (e.g. the search
 *   screen's subtitle). No hashtag chips: those slots are never
 *   xpath-evaluated, so a `#type/path` chip would promise a live
 *   reference the runtime can't honor.
 * - `createInlineEditorExtensions` — base + CommcareRef + Mention, for
 *   form-context surfaces (labels, hints) where hashtag references are
 *   real. CommcareRef nodes round-trip through the markdown-it pipeline as
 *   `<span data-nova-prose-ref="…">`, carrying the ENCODED typed part rather
 *   than a hashtag, so identity survives the trip and no text is ever parsed
 *   back into a reference. Conversion to text is an explicit editor action
 *   that resolves the current spelling through the owning document.
 *
 * Contrast with RefLabelInput which uses StarterKit with everything
 * disabled except paragraphs — that editor is text-only with chips.
 * These editors are full WYSIWYG surfaces.
 */

import type { Extensions } from "@tiptap/core";
import { Image } from "@tiptap/extension-image";
import { Link } from "@tiptap/extension-link";
import Mention from "@tiptap/extension-mention";
import { TableCell, TableHeader, TableRow } from "@tiptap/extension-table";
import StarterKit from "@tiptap/starter-kit";
import { Markdown } from "tiptap-markdown";
import {
	canonicalProseTemplate,
	type ProsePart,
	type ProseTemplate,
} from "@/lib/domain";
import { isInlinePicture } from "@/lib/links/inlinePicture";
import { isOpenableAddress } from "@/lib/links/openableAddress";
import type { ReferenceProvider } from "@/lib/references/provider";
import {
	CommcareRef,
	decodeProseReferencePart,
	PROSE_CARRIER_COMMENT,
	serializedProseReferencePart,
} from "./commcareRefNode";
import { LabelHtml } from "./labelHtml";
import { MarkdownTable } from "./markdownTable";
import { createRefSuggestion } from "./refSuggestion";

/** A worker's link still has its address after its label is edited, even
 * where the builder cannot open it. Copied content keeps that address too. */
const LabelLink = Link.extend({
	parseHTML() {
		return [
			...(this.parent?.() ?? []),
			{
				tag: "span[data-nova-link-href]",
				getAttrs: (element) => ({
					href: element.getAttribute("data-nova-link-href"),
				}),
			},
		];
	},
	renderHTML({ HTMLAttributes }) {
		const { href, title } = HTMLAttributes;
		if (typeof href === "string" && isOpenableAddress(href))
			return [
				"a",
				{ href, title, target: "_blank", rel: "noopener noreferrer" },
				0,
			];
		return ["span", { "data-nova-link-href": href, title }, 0];
	},
});

/** Keep the picture's address in the document and in copied editor content.
 * Only an embedded image has a live src on the builder page. */
const LabelImage = Image.extend({
	parseHTML() {
		return [
			...(this.parent?.() ?? []),
			{
				tag: "span[data-nova-image-src]",
				getAttrs: (element) => ({
					src: element.getAttribute("data-nova-image-src"),
				}),
			},
		];
	},
	renderHTML({ HTMLAttributes }) {
		const { src, ...attributes } = HTMLAttributes;
		if (typeof src === "string" && isInlinePicture(src))
			return ["img", HTMLAttributes];
		return [
			"span",
			{ ...attributes, "data-nova-image-src": src },
			attributes.alt ?? "",
		];
	},
});

/**
 * The chip-free WYSIWYG extension set — the CommCare Web Apps markdown
 * feature set with bidirectional markdown conversion and nothing else.
 */
export function createMarkdownEditorExtensions(): Extensions {
	return [
		StarterKit.configure({
			/* Headings limited to 1-3 — deeper levels aren't useful in form labels. */
			heading: { levels: [1, 2, 3] },
			link: false,
			/* Blockquote and strikethrough are disabled because CommCare Web Apps
			 * has no visible styling for either — blockquotes render identically to
			 * paragraphs (Bootstrap reboot margin only), and markdown-it's
			 * strikethrough plugin is not loaded. Exposing them here would give
			 * users a false impression of how their content will render. */
			blockquote: false,
			strike: false,
		}),
		LabelLink.configure({ openOnClick: false, autolink: false }),
		/* Inline images — `![alt](url)` in markdown. */
		LabelImage.configure({ inline: true, allowBase64: true }),
		LabelHtml,
		/* GFM pipe tables — `| col | col |` syntax. Requires all four table
		 * node types (table, row, header cell, body cell) for ProseMirror. */
		MarkdownTable.configure({ resizable: false }),
		TableRow,
		TableHeader,
		TableCell,
		Markdown.configure({
			html: true,
			breaks: true,
			transformPastedText: true,
			transformCopiedText: true,
		}),
	];
}

/**
 * The form-context extension set: the base markdown editor plus
 * CommcareRef hashtag round-tripping and the `#` Mention trigger for
 * chip autocomplete.
 *
 * @param provider - ReferenceProvider for hashtag autocomplete (null disables autocomplete)
 * @param getFormUuid - Resolves the form whose readable refs the autocomplete
 *   offers (the active form being edited)
 */
export function createInlineEditorExtensions(
	provider: ReferenceProvider | null,
	getFormUuid: () => string | undefined,
): Extensions {
	const suggestion = provider
		? createRefSuggestion(provider, getFormUuid)
		: undefined;

	return [
		...createMarkdownEditorExtensions(),
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

/** Markdown carrier used only at the TipTap boundary; references stay typed. */
export function proseTemplateToMarkdown(template: ProseTemplate): string {
	return template.parts
		.map((part) =>
			part.kind === "text" ? part.text : serializedProseReferencePart(part),
		)
		.join("");
}

const PROSE_REFERENCE_CARRIER_RE = new RegExp(
	`<span data-nova-prose-ref="([^"]+)">${PROSE_CARRIER_COMMENT}</span>`,
	"g",
);

/**
 * Recover typed atoms emitted by CommcareRef's serializer. Ordinary Markdown,
 * including hashtag-looking text, remains literal authored text.
 */
export function markdownToProseTemplate(markdown: string): ProseTemplate {
	const parts: ProsePart[] = [];
	let cursor = 0;
	for (const match of markdown.matchAll(PROSE_REFERENCE_CARRIER_RE)) {
		const index = match.index;
		if (index > cursor) {
			parts.push({ kind: "text", text: markdown.slice(cursor, index) });
		}
		const reference = decodeProseReferencePart(match[1]);
		if (reference) parts.push(reference);
		else parts.push({ kind: "text", text: match[0] });
		cursor = index + match[0].length;
	}
	if (cursor < markdown.length) {
		parts.push({ kind: "text", text: markdown.slice(cursor) });
	}
	return canonicalProseTemplate(parts, { trim: true });
}
