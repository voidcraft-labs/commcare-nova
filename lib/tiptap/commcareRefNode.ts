/**
 * Custom TipTap node extension for CommCare hashtag references.
 *
 * Renders #form/, #case/, #user/ references as inline atom chips within
 * TipTap editors. The node stores three attributes:
 *   - refType: 'form' | 'case' | 'user' — determines color and icon
 *   - path: the property/question path (e.g. "patient_name", "group1/age")
 *   - label: human-readable display text (falls back to path)
 *
 * Round-trips through HTML via <span data-commcare-ref data-ref-type data-path data-label>.
 *
 * Markdown serialization (tiptap-markdown):
 *   - Serialize: writes bare `#type/path` hashtags (canonical internal format).
 *   - Parse: handled externally by `hydrateHashtagRefs()` — after tiptap-markdown
 *     parses the markdown string, hydrateRefs walks the resulting ProseMirror
 *     document and replaces bare `#type/path` text with commcareRef atom nodes.
 *
 * Backspace-to-revert: when the cursor is right after a commcareRef node,
 * backspace converts it back to raw text minus the last character, causing
 * the suggestion popup to re-trigger on the partial match.
 */

import { mergeAttributes, Node } from "@tiptap/core";
import { ReactNodeViewRenderer } from "@tiptap/react";
import { CommcareRefView } from "./CommcareRefView";

export const CommcareRef = Node.create({
	name: "commcareRef",
	group: "inline",
	inline: true,
	atom: true,

	/**
	 * Markdown serialization for tiptap-markdown. Writes commcareRef nodes as
	 * bare `#type/path` hashtags — the canonical internal format. Parsing is
	 * handled externally by `hydrateHashtagRefs()` after content is loaded.
	 */
	addStorage() {
		return {
			markdown: {
				serialize(
					state: { write: (s: string) => void },
					node: { attrs: { refType: string; path: string } },
				) {
					state.write(`#${node.attrs.refType}/${node.attrs.path}`);
				},
			},
		};
	},

	/** Node attributes mapping to the Reference type's fields. */
	addAttributes() {
		return {
			/** Reference namespace: 'form' | 'case' | 'user'. */
			refType: { default: "form" },
			/** Property/question path within the namespace. */
			path: { default: "" },
			/** Human-readable label (used for accessibility, falls back to path). */
			label: { default: "" },
		};
	},

	/**
	 * Parse from HTML: reads data attributes from <span data-commcare-ref>.
	 * The `el` param is always an HTMLElement here because the tag selector
	 * already matched — the cast is safe.
	 */
	parseHTML() {
		return [
			{
				tag: "span[data-commcare-ref]",
				getAttrs: (el) => {
					const dom = el as HTMLElement;
					return {
						refType: dom.getAttribute("data-ref-type") ?? "form",
						path: dom.getAttribute("data-path") ?? "",
						label: dom.getAttribute("data-label") ?? dom.textContent ?? "",
					};
				},
			},
		];
	},

	/** Serialize to HTML: produces <span data-commcare-ref ...>label</span>. */
	renderHTML({ node, HTMLAttributes }) {
		return [
			"span",
			mergeAttributes(HTMLAttributes, {
				"data-commcare-ref": "",
				"data-ref-type": node.attrs.refType,
				"data-path": node.attrs.path,
				"data-label": node.attrs.label,
			}),
			node.attrs.label || node.attrs.path,
		];
	},

	/** Render via React NodeView for rich chip display with icon and styling. */
	addNodeView() {
		return ReactNodeViewRenderer(CommcareRefView, { as: "span" });
	},

	addKeyboardShortcuts() {
		return {
			/**
			 * Backspace-to-revert: when the cursor is immediately after a
			 * commcareRef node, delete the node and insert its raw text minus
			 * the last character. This exposes the partial text (e.g.
			 * "#form/patient_nam") and re-triggers the suggestion popup.
			 */
			Backspace: ({ editor }) => {
				const { state } = editor;
				const { $anchor } = state.selection;

				if (!state.selection.empty) return false;

				const posBefore = $anchor.pos;
				if (posBefore <= 0) return false;

				const nodeBefore = state.doc.resolve(posBefore).nodeBefore;
				if (!nodeBefore || nodeBefore.type.name !== "commcareRef") return false;

				/* Build the canonical form and trim the last character for re-suggestion. */
				const raw = `#${nodeBefore.attrs.refType}/${nodeBefore.attrs.path}`;
				const reverted = raw.slice(0, -1);
				const nodeStart = posBefore - nodeBefore.nodeSize;

				editor
					.chain()
					.focus()
					.command(({ tr }) => {
						tr.delete(nodeStart, posBefore);
						tr.insertText(reverted, nodeStart);
						return true;
					})
					.run();

				return true;
			},
		};
	},
});
