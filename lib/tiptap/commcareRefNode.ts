/**
 * TipTap inline atom for one canonical ProseTemplate atom: a reference part or
 * a calculated value.
 *
 * The atom stores the exact typed identity arm. Hashtag-looking text is never
 * parsed or promoted; only the explicit suggestion/convert command inserts
 * this node.
 */

import { mergeAttributes, Node } from "@tiptap/core";
import { ReactNodeViewRenderer } from "@tiptap/react";
import { type ProseAtomPart, prosePartSchema } from "@/lib/domain";
import { CommcareRefView } from "./CommcareRefView";

const DATA_ATTR = "data-nova-prose-ref";
/** U+FFFF cannot occur in admitted app text (XML 1.0 Char). In an HTML
 * comment even a literal character reference stays text. This distinguishes
 * the typed part we inserted from identical markup the author typed. */
export const PROSE_CARRIER_MARK = "\uffff";
export const PROSE_CARRIER_COMMENT = `<!--${PROSE_CARRIER_MARK}-->`;

export function encodeProseReferencePart(part: ProseAtomPart): string {
	return encodeURIComponent(JSON.stringify(part));
}

export function decodeProseReferencePart(
	encoded: string | null | undefined,
): ProseAtomPart | null {
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

export function serializedProseReferencePart(part: ProseAtomPart): string {
	return `<span ${DATA_ATTR}="${encodeProseReferencePart(part)}">${PROSE_CARRIER_COMMENT}</span>`;
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
					node: { attrs: { part: ProseAtomPart } },
				) {
					state.write(serializedProseReferencePart(node.attrs.part));
				},
			},
		};
	},

	addAttributes() {
		return {
			/* Identity comes only from the decoded carrier. An HTML attribute
			 * named "part" would stringify the object and override getAttrs
			 * when the serialized node is read again. */
			part: { default: null, rendered: false, parseHTML: () => null },
			label: { default: "", rendered: false, parseHTML: () => null },
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
});
