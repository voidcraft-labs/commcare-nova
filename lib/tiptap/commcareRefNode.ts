/**
 * TipTap inline atom for one canonical ProseTemplate reference part.
 *
 * The atom stores the exact typed identity arm. Hashtag-looking text is never
 * parsed or promoted; only the explicit suggestion/convert command inserts
 * this node.
 */

import { mergeAttributes, Node } from "@tiptap/core";
import { ReactNodeViewRenderer } from "@tiptap/react";
import { type ProseReferencePart, prosePartSchema } from "@/lib/domain";
import { CommcareRefView } from "./CommcareRefView";

const DATA_ATTR = "data-nova-prose-ref";

export function encodeProseReferencePart(part: ProseReferencePart): string {
	return encodeURIComponent(JSON.stringify(part));
}

export function decodeProseReferencePart(
	encoded: string | null | undefined,
): ProseReferencePart | null {
	if (!encoded) return null;
	try {
		const parsed = prosePartSchema.safeParse(
			JSON.parse(decodeURIComponent(encoded)),
		);
		return parsed.success && parsed.data.kind !== "text" ? parsed.data : null;
	} catch {
		return null;
	}
}

export function serializedProseReferencePart(part: ProseReferencePart): string {
	return `<span ${DATA_ATTR}="${encodeProseReferencePart(part)}"></span>`;
}

export const CommcareRef = Node.create({
	name: "commcareRef",
	group: "inline",
	inline: true,
	atom: true,

	addStorage() {
		return {
			markdown: {
				serialize(
					state: { write: (value: string) => void },
					node: { attrs: { part: ProseReferencePart } },
				) {
					state.write(serializedProseReferencePart(node.attrs.part));
				},
			},
		};
	},

	addAttributes() {
		return {
			part: { default: null },
			label: { default: "" },
		};
	},

	parseHTML() {
		return [
			{
				tag: `span[${DATA_ATTR}]`,
				getAttrs: (element) => {
					const dom = element as HTMLElement;
					const part = decodeProseReferencePart(dom.getAttribute(DATA_ATTR));
					return part
						? { part, label: dom.getAttribute("data-label") ?? "" }
						: false;
				},
			},
		];
	},

	renderHTML({ node, HTMLAttributes }) {
		const part = prosePartSchema.safeParse(node.attrs.part);
		if (!part.success || part.data.kind === "text") return ["span", {}, ""];
		// `label` is the chip's projection, resolved against the document when the
		// atom was built. A `Node`'s static `renderHTML` has no document, and the
		// React node view is what actually draws the chip — so this emits the
		// stored label and nothing else. Inventing a spelling inside a serializer
		// would put text on the page that no document produced; the encoded
		// `data-nova-prose-ref` attribute is what preserves identity regardless.
		return [
			"span",
			mergeAttributes(HTMLAttributes, {
				"data-commcare-ref": "",
				[DATA_ATTR]: encodeProseReferencePart(part.data),
				"data-label": node.attrs.label,
			}),
			node.attrs.label,
		];
	},

	addNodeView() {
		return ReactNodeViewRenderer(CommcareRefView, { as: "span" });
	},

	addKeyboardShortcuts() {
		return {
			Backspace: ({ editor }) => {
				const { state } = editor;
				const { $anchor } = state.selection;
				if (!state.selection.empty || $anchor.pos <= 0) return false;
				const nodeBefore = state.doc.resolve($anchor.pos).nodeBefore;
				if (nodeBefore?.type.name !== "commcareRef") return false;
				const parsed = prosePartSchema.safeParse(nodeBefore.attrs.part);
				if (!parsed.success || parsed.data.kind === "text") return false;
				// Backspace turns the chip back into the text it was showing, minus
				// the character just deleted, so editing continues where the author
				// was looking. That text is the chip's own projection — `label` —
				// resolved against the document when the atom was built. It must not
				// come from a context-free projector, which has no document and so
				// would type `#form/[reference needs repair]` into authored prose.
				//
				// The label is not always there. `serializedProseReferencePart` writes
				// only the encoded part, so a chip parsed from that carrier — every
				// chip in the markdown-backed inline editor — has an empty label. This
				// convenience simply does not apply to those, and claiming otherwise by
				// running a bespoke delete would make Backspace destroy a reference on
				// a surface where it cannot offer the replacement text. Falling through
				// gives them ProseMirror's ordinary atom deletion: visible, undoable,
				// and identical to every other inline atom.
				const label =
					typeof nodeBefore.attrs.label === "string"
						? nodeBefore.attrs.label
						: "";
				if (label.length === 0) return false;
				const nodeStart = $anchor.pos - nodeBefore.nodeSize;
				editor
					.chain()
					.focus()
					.command(({ tr }) => {
						tr.delete(nodeStart, $anchor.pos);
						tr.insertText(label.slice(0, -1), nodeStart);
						return true;
					})
					.run();
				return true;
			},
		};
	},
});
