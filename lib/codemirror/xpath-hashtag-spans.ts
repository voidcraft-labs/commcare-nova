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
 * Return only grammar-owned hashtag spans. Lezer error recovery may still
 * construct a `HashtagRef`; a nested error makes that span ineligible.
 */
export function cleanXPathHashtagSpans(value: string): XPathHashtagSpan[] {
	const spans: XPathHashtagSpan[] = [];
	parser.parse(value).iterate({
		enter(node) {
			if (node.type !== HASHTAG_REF) return;
			let clean = true;
			node.node.toTree().iterate({
				enter(inner) {
					if (inner.type.isError) clean = false;
				},
			});
			if (clean) {
				spans.push({
					text: value.slice(node.from, node.to),
					start: node.from,
					end: node.to,
				});
			}
			return false;
		},
	});
	return spans;
}
