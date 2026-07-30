/**
 * TipTap inline atom for one canonical ProseTemplate reference part.
 *
 * The atom stores the exact typed identity arm. Hashtag-looking text is never
 * parsed or promoted; only the explicit suggestion/convert command inserts
 * this node.
 */

import { mergeAttributes, Node } from "@tiptap/core";
import { ReactNodeViewRenderer } from "@tiptap/react";
import {
	fallbackProseProjection,
	type ProseReferencePart,
	prosePartSchema,
} from "@/lib/domain";
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
		const fallback = fallbackProseProjection({ parts: [part.data] });
		return [
			"span",
			mergeAttributes(HTMLAttributes, {
				"data-commcare-ref": "",
				[DATA_ATTR]: encodeProseReferencePart(part.data),
				"data-label": node.attrs.label,
			}),
			node.attrs.label || fallback,
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
				// was looking. That text is the chip's own current projection —
				// `label` — which was resolved against the document when the atom was
				// built.
				//
				// It must NOT come from the context-free projector. Without a
				// document that returns `#form/[reference needs repair]`, so this
				// typed a truncated repair marker into the author's prose and lost the
				// reference. A repair marker is a display state for a chip; as
				// authored text it is a string that looks like a reference and can
				// never resolve.
				const label =
					typeof nodeBefore.attrs.label === "string"
						? nodeBefore.attrs.label
						: "";
				const nodeStart = $anchor.pos - nodeBefore.nodeSize;
				editor
					.chain()
					.focus()
					.command(({ tr }) => {
						tr.delete(nodeStart, $anchor.pos);
						// No label means nothing was ever projected for this chip, so
						// there is no honest text to leave behind. Removing it is the
						// truthful outcome; inventing text is not.
						if (label.length > 0) {
							tr.insertText(label.slice(0, -1), nodeStart);
						}
						return true;
					})
					.run();
				return true;
			},
		};
	},
});
