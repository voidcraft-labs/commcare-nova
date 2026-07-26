import { parser } from "@/lib/commcare/xpath";

export interface XPathHashtagSpan {
	readonly text: string;
	readonly start: number;
	readonly end: number;
}

const HASHTAG_REF = (() => {
	const node = parser.nodeSet.types.find((type) => type.name === "HashtagRef");
	if (!node) throw new Error("XPath parser has no HashtagRef node");
	return node;
})();

/**
 * Return grammar-owned hashtag spans only when the whole expression parsed
 * without recovery. Lezer can construct a complete-looking `HashtagRef` below
 * a recovered parent (for example the `#user/region` prefix of
 * `#user/region/`); no span from such a tree is safe for source rewriting.
 */
export function cleanXPathHashtagSpans(
	value: string,
): XPathHashtagSpan[] | null {
	const spans: XPathHashtagSpan[] = [];
	let recovered = false;
	parser.parse(value).iterate({
		enter(node) {
			if (node.type.isError) {
				recovered = true;
			} else if (node.type === HASHTAG_REF) {
				spans.push({
					text: value.slice(node.from, node.to),
					start: node.from,
					end: node.to,
				});
			}
		},
	});
	return recovered ? null : spans;
}
